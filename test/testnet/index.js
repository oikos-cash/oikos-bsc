'use strict';

const fs = require('fs');
const path = require('path');

const Web3 = require('web3');

const { yellow, gray, red, green } = require('chalk');

const commander = require('commander');
const program = new commander.Command();

const { toWei } = require('web3-utils');
require('dotenv').config();

const snx = require('../..');
const { toBytes32, getPathToNetwork } = snx;

const commands = {
	build: require('../../publish/src/commands/build').build,
	deploy: require('../../publish/src/commands/deploy').deploy,
};

const testUtils = require('../utils');

const { loadConnections, confirmAction, ensureNetwork } = require('../../publish/src/util');

const logExchangeRates = (
	currencyKeys,
	rates,
	times,
	timestamp = Math.round(Date.now() / 1000)
) => {
	const results = [];
	for (let i = 0; i < rates.length; i++) {
		const rate = Web3.utils.fromWei(rates[i]);
		results.push({
			key: currencyKeys[i].name,
			price: rate,
			date: new Date(times[i] * 1000),
			ago: timestamp - times[i],
		});
	}
	for (const rate of results) {
		console.log(
			gray('currencyKey:'),
			yellow(rate.key),
			gray('price:'),
			yellow(rate.price),
			gray('when:'),
			yellow(Math.round(rate.ago / 60), gray('mins ago'))
		);
	}
};

program
	.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'testnet')
	.option('-g, --gas-price <value>', 'Gas price in GWEI', '5')
	.option('-y, --yes', 'Dont prompt, just reply yes.')
	.action(async ({ network, yes, gasPrice: gasPriceInGwei }) => {
		ensureNetwork(network);

		let esLinkPrefix;
		try {
			console.log(`Running tests on ${network}`);

			const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
				network,
			});
			esLinkPrefix = etherscanLinkPrefix;

			let privateKey = envPrivateKey;

			const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));

			const { loadLocalUsers, isCompileRequired, fastForward, currentTime } = testUtils({ web3 });

			const synths = snx.getSynths({ network });

			const gas = 4e6; // 4M
			const gasPrice = toWei(gasPriceInGwei, 'gwei');
			const [oUSD, oETH] = ['oUSD', 'oETH'].map(toBytes32);

			const updateableSynths = synths.filter(({ name }) => ['oUSD'].indexOf(name) < 0);
			const cryptoSynths = synths
				.filter(({ asset }) => asset !== 'USD')
				.filter(
					({ category }) => category === 'crypto' || category === 'internal' || category === 'index'
				);

			const forexSynths = synths
				.filter(({ asset }) => asset !== 'USD')
				.filter(({ category }) => category === 'forex' || category === 'commodity');

			let timestamp; // used for local

			// when run on the local network,
			if (network === 'local') {
				// build
				if (isCompileRequired()) {
					await commands.build();
				}
				// load accounts used by local EVM
				const users = loadLocalUsers();

				// and use the first as the main private key (owner/deployer)
				privateKey = users[0].private;

				// now deploy
				await commands.deploy({
					network,
					deploymentPath: getPathToNetwork({ network }),
					yes: true,
					privateKey,
				});

				// now setup rates
				// make sure exchange rates has a price
				const ExchangeRates = new web3.eth.Contract(
					snx.getSource({ network, contract: 'ExchangeRates' }).abi,
					snx.getTarget({ network, contract: 'ExchangeRates' }).address
				);

				timestamp = await currentTime();

				// update rates
				await ExchangeRates.methods
					.updateRates(
						[toBytes32('SNX'), toBytes32('ETH')].concat(
							updateableSynths.map(({ name }) => toBytes32(name))
						),
						[toWei('0.3'), toWei('1')].concat(updateableSynths.map(() => toWei('1'))),
						timestamp
					)
					.send({
						from: users[0].public,
						gas,
						gasPrice,
					});
			}

			const sources = snx.getSource({ network });
			const targets = snx.getTarget({ network });

			const owner = web3.eth.accounts.wallet.add(privateKey);

			// We are using the testnet deployer account, so presume they have some testnet ETH
			const user1 = web3.eth.accounts.create();
			web3.eth.accounts.wallet.add(user1);
			console.log(gray(`Created test account ${user1.address}`));
			console.log(gray(`Owner account ${owner.address}`));

			// store keys in local file in case error and need to recover account
			fs.appendFileSync(
				path.join(__dirname, 'test_keys.txt'),
				`${new Date().toString()}\t\t${network}\t\t${user1.address}\t\t${user1.privateKey}\n`
			);
			console.log(gray(`Test privkeys: ${user1.privateKey}`));

			/** VIEWS OF SYNTHETIX STATUS **/

			const exchangeRates = new web3.eth.Contract(
				sources['ExchangeRates'].abi,
				targets['ExchangeRates'].address
			);
			const currencyKeys = [{ name: 'OKS' }].concat(cryptoSynths).concat(forexSynths);
			const currencyKeysBytes = currencyKeys.map(key => toBytes32(key.name));

			// View all current ExchangeRates
			const rates = await exchangeRates.methods.ratesForCurrencies(currencyKeysBytes).call();

			const times = await exchangeRates.methods
				.lastRateUpdateTimesForCurrencies(currencyKeysBytes)
				.call();

			logExchangeRates(currencyKeys, rates, times, timestamp);

			const ratesAreStale = await exchangeRates.methods.anyRateIsStale(currencyKeysBytes).call();

			console.log(green(`RatesAreStale - ${ratesAreStale}`));
			if (ratesAreStale) {
				throw Error('Rates are stale');
			}

			// Oikos contract
			const Oikos = new web3.eth.Contract(
				sources['Oikos'].abi,
				targets['ProxyERC20'].address
			);

			const OikosState = new web3.eth.Contract(
				sources['OikosState'].abi,
				targets['OikosState'].address
			);

			const Exchanger = new web3.eth.Contract(
				sources['Exchanger'].abi,
				targets['Exchanger'].address
			);

			const EtherCollateral = new web3.eth.Contract(
				sources['BNBCollateral'].abi,
				targets['BNBCollateral'].address
			);

			const Issuer = new web3.eth.Contract(sources['Issuer'].abi, targets['Issuer'].address);

			const Depot = new web3.eth.Contract(sources['Depot'].abi, targets['Depot'].address);
			const SynthoUSD = new web3.eth.Contract(
				sources['Synth'].abi,
				targets['ProxyERC20'].address
			);
			// Check totalIssuedSynths and debtLedger matches
			const totalIssuedSynths = 0;//await Oikos.methods.totalIssuedSynths(oUSD).call();
			const debtLedgerLength = await OikosState.methods.debtLedgerLength().call();
			

			console.log(
				green(
					`TotalIssuedSynths in oUSD: ${totalIssuedSynths} - debtLedgerLenght: ${debtLedgerLength}`
				)
			);

			if (debtLedgerLength > 0 && totalIssuedSynths === 0) {
				throw Error('DebtLedger has debt but totalIssuedSynths is 0');
			}

			const feePool = new web3.eth.Contract(sources['FeePool'].abi, targets['FeePool'].address);
			const feePeriodLength = await feePool.methods.FEE_PERIOD_LENGTH().call();

			// Unless on local, check feePeriods are imported for feePool correctly with feePeriodId set
			if (network !== 'local') {
				for (let i = 0; i < feePeriodLength; i++) {
					const period = await feePool.methods.recentFeePeriods(i).call();
					if (period.feePeriodId === '0') {
						throw Error(
							`Fee period at index ${i} has not been set. Check if fee periods have been imported`
						);
					}
				}
			}

			console.log(gray(`Using gas price of ${gasPriceInGwei} gwei.`));

			if (!yes) {
				try {
					await confirmAction(yellow(`Do you want to continue? (y/n) `));
				} catch (err) {
					console.log(gray(`Operation terminated`));
					return;
				}
			}

			const txns = [];

			const lastTxnLink = () => `${etherscanLinkPrefix}/tx/${txns.slice(-1)[0].transactionHash}`;

			// #1 - Send the account some test ether
			console.log(gray(`Transferring 0.05 test BNB to ${user1.address}`));
			txns.push(
				await web3.eth.sendTransaction({
					from: owner.address,
					to: user1.address,
					value: web3.utils.toWei('0.05'),
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// Note: we are using numbers in WEI to 1e-13 not ether (i.e. not with 18 decimals),
			// so that if a test fails we only lose minor amounts of SNX and oUSD (i.e. dust). - JJ

			// #2 - Now some test SNX
			console.log(gray(`Transferring 2e-12 SNX to user1 (${user1.address})`));
			txns.push(
				await Oikos.methods.transfer(user1.address, web3.utils.toWei('0.000000000002')).send({
					from: owner.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// #3 - Mint some oUSD from test account
			console.log(gray(`Issuing 1e-13 oUSD from (${user1.address}`));
			const amountToIssue = web3.utils.toWei('0.0000000000001');
			txns.push(
				await Oikos.methods.issueSynths(amountToIssue).send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// get balance
			const balance = await SynthoUSD.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has oUSD balanceOf - ${balance}`));

			// #4 - Deposit oUSD to Depot, approve first
			console.log(gray(`SynthoUSD approve to use Depot`));
			txns.push(
				await SynthoUSD.methods.approve(Depot.options.address, toWei('1')).send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// then deposit
			console.log(gray(`Deposit 1e-14 oUSD to Depot from (${user1.address})`));
			const amountToDeposit = web3.utils.toWei('0.00000000000001');
			txns.push(
				await Depot.methods.depositSynths(amountToDeposit).send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// check balance
			const balanceAfter = await SynthoUSD.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has oUSD balanceOf - ${balanceAfter}`));

			// #5 Exchange oUSD to oETH
			console.log(gray(`Exchange 1e-14 oUSD --> oETH for user - (${user1.address})`));
			const amountToExchange = web3.utils.toWei('0.00000000000001');
			txns.push(
				await Oikos.methods.exchange(oUSD, amountToExchange, oETH).send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// check oETH balance after exchange
			const SynthoETH = new web3.eth.Contract(sources['Synth'].abi, targets['ProxyoETH'].address);
			const oETHBalance = await SynthoETH.methods.balanceOf(user1.address).call();
			console.log(gray(`User1 has oETH balanceOf - ${oETHBalance}`));

			// #6 + EtherCollateral open close loan
			// step 1: allow a tiny loan
			const ethCollateralMinLoanSize = await EtherCollateral.methods.minLoanSize().call();
			console.log(gray(`Setting EtherCollateral minLoanSize to 1e-16 ETH`));
			txns.push(
				await EtherCollateral.methods
					.setMinLoanSize(toWei('0.0000000000000001'))
					.send({ from: owner.address, gas, gasPrice })
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// step 2: open a loan
			console.log(gray(`Open 1e-16 ETH loan for user (${user1.address})`));
			txns.push(
				await EtherCollateral.methods
					.openLoan()
					.send({ from: user1.address, value: toWei('0.0000000000000001'), gas, gasPrice })
			);
			const { loanID } = txns.slice(-1)[0].events.LoanCreated.returnValues;
			console.log(green(`Success, loadID: ${loanID}. ${lastTxnLink()}`));

			// step 3: close the loan
			console.log(gray(`Close loanID: ${loanID} for user (${user1.address})`));
			txns.push(
				await EtherCollateral.methods.closeLoan(loanID).send({ from: user1.address, gas, gasPrice })
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// step 4: return minLoanSize to original value
			console.log(gray(`Setting EtherCollateral minLoanSize back to original value`));
			txns.push(
				await EtherCollateral.methods
					.setMinLoanSize(ethCollateralMinLoanSize)
					.send({ from: owner.address, gas, gasPrice })
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// #7 Exchange balance of oETH back to oUSD
			const tryExchangeBack = async () => {
				console.log(gray(`Exchange oETH --> oUSD for user - (${user1.address})`));
				txns.push(
					await Oikos.methods.exchange(oETH, oETHBalance, oUSD).send({
						from: user1.address,
						gas,
						gasPrice,
					})
				);
				console.log(green(`Success. ${lastTxnLink()}`));
			};

			const waitingPeriodSecs = await Exchanger.methods.waitingPeriodSecs().call();

			try {
				await tryExchangeBack();

				console.error(red('Should have failed immediately exchanging back by Fee Reclamation'));
				process.exitCode = 1;
			} catch (err) {
				// Expect to fail as the waiting period is ongoing
				// Can't guarantee getting the revert reason however.
				await new Promise((resolve, reject) => {
					if (network === 'local') {
						console.log(
							gray(
								`Fast forward ${waitingPeriodSecs}s until we can exchange the dest synth again...`
							)
						);
						fastForward(waitingPeriodSecs)
							.then(tryExchangeBack)
							.then(resolve)
							.catch(reject);
					} else {
						console.log(
							gray(`Waiting ${waitingPeriodSecs}s until we can exchange the dest synth again...`)
						);
						setTimeout(async () => {
							await tryExchangeBack();
							resolve();
						}, +waitingPeriodSecs * 1000);
					}
				});
			}

			// #8 Burn all remaining oUSD to unlock SNX

			// set minimumStakeTime to 0 to allow burning oUSD to unstake
			console.log(gray(`Setting minimum stake time after issuing synths to 0`));
			txns.push(
				await Issuer.methods.setMinimumStakeTime(0).send({ from: owner.address, gas, gasPrice })
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			const remainingSynthoUSD = await SynthoUSD.methods.balanceOf(user1.address).call();
			const tryBurn = async () => {
				console.log(gray(`Burn all remaining synths for user - (${user1.address})`));
				txns.push(
					await Oikos.methods.burnSynths(remainingSynthoUSD).send({
						from: user1.address,
						gas,
						gasPrice,
					})
				);
				console.log(green(`Success. ${lastTxnLink()}`));
			};

			try {
				await tryBurn();

				console.error(
					red('Should have failed burning after exchanging into oUSD by Fee Reclamation')
				);
				process.exitCode = 1;
				return;
			} catch (err) {
				// Expect to fail as the waiting period is ongoing
				// Can't guarantee getting the revert reason however.
				await new Promise((resolve, reject) => {
					if (network === 'local') {
						console.log(
							gray(`Fast forward ${waitingPeriodSecs}s until we can try burn dest synth again...`)
						);
						fastForward(waitingPeriodSecs)
							.then(tryBurn)
							.then(resolve)
							.catch(reject);
					} else {
						console.log(
							gray(`Waiting ${waitingPeriodSecs}s until we can try burn dest synth again...`)
						);
						setTimeout(async () => {
							await tryBurn();
							resolve();
						}, +waitingPeriodSecs * 1000);
					}
				});
			}

			// check transferable SNX after burning
			const transferableSNX = await Oikos.methods.transferableOikos(user1.address).call();
			console.log(gray(`Transferable SNX of ${transferableSNX} for user (${user1.address}`));

			// #9 Transfer SNX back to owner
			console.log(gray(`Transferring SNX back to owner (${user1.address}`));
			txns.push(
				await Oikos.methods.transfer(user1.address, transferableSNX).send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			// TODO: if fees available claim, check feePeriod closable, close if it can be closed and claim fees.

			// #10 Withdraw any remaining deposited synths from Depot
			console.log(gray(`Withdraw any remaining oUSD from Depot for (${user1.address})`));
			txns.push(
				await Depot.methods.withdrawMyDepositedSynths().send({
					from: user1.address,
					gas,
					gasPrice,
				})
			);

			const {
				events: { SynthWithdrawal },
			} = txns.slice(-1)[0];

			console.log(
				green(`Success, withdrawed ${SynthWithdrawal.returnValues.amount} oUSD. ${lastTxnLink()}`)
			);

			// #11 finally, send back all test ETH to the owner
			const testEthBalanceRemaining = await web3.eth.getBalance(user1.address);
			const gasLimitForTransfer = 21010; // a little over 21k to prevent occassional out of gas errors
			const testETHBalanceMinusTxnCost = (
				testEthBalanceRemaining -
				gasLimitForTransfer * gasPrice
			).toString();

			// set minimumStakeTime back to 1 minute on testnets
			console.log(gray(`set minimumStakeTime back to 60 seconds on testnets`));
			txns.push(
				await Issuer.methods.setMinimumStakeTime(60).send({ from: owner.address, gas, gasPrice })
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			console.log(
				gray(
					`Transferring remaining test ETH back to owner (${web3.utils.fromWei(
						testETHBalanceMinusTxnCost
					)})`
				)
			);
			txns.push(
				await web3.eth.sendTransaction({
					from: user1.address,
					to: owner.address,
					value: testETHBalanceMinusTxnCost,
					gas: gasLimitForTransfer,
					gasPrice,
				})
			);
			console.log(green(`Success. ${lastTxnLink()}`));

			console.log();
			console.log(gray(`Integration test on ${network.toUpperCase()} completed successfully.`));
		} catch (err) {
			if (/Transaction has been reverted/.test(err)) {
				const txnHash = err.message.match(/(?:"transactionHash":\s")(\w+)(")/)[1];
				console.error(red(`Failure: EVM reverted ${esLinkPrefix}/tx/${txnHash}`));
			} else {
				console.error(err);
			}
			process.exitCode = 1;
		}
	});

// perform as CLI tool if not run as module
if (require.main === module) {
	require('pretty-error').start();

	program.parse(process.argv);
}
