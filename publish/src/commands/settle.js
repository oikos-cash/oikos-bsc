'use strict';

const { gray, yellow, red, cyan, green } = require('chalk');
const fs = require('fs');
const path = require('path');
const Web3 = require('web3');
const minimist = require('minimist');
const cleanEntries = require("./cleanEntries");

const { getTarget, getSource, toBytes32 } = require('../../..');

const { ensureNetwork, loadConnections, stringify } = require('../util');

const fromBlockMap = {
	testnet: 10367492,
	bsc: 9352473,
};

const pathToLocal = name => path.join(__dirname, `${name}.json`);

const saveExchangesToFile = ({ network, exchanges, fromBlock }) => {
	fs.writeFileSync(pathToLocal(`exchanges-${network}-${fromBlock}`), stringify(exchanges));
};

const loadExchangesFromFile = ({ network, fromBlock }) => {
	return JSON.parse(fs.readFileSync(pathToLocal(`exchanges-${network}-${fromBlock}`)).toString());
};

const settle = async ({
	network,
	range=0,
	fromBlock = fromBlockMap[network],
	dryRun,
	latest,
	gasPrice,
	gasLimit,
	privateKey,
	ethToSeed,
	showDebt,
	args,
}) => {
	ensureNetwork(network);
	console.log(range)
	console.log(gray('Using network:', yellow(network)));

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
	});

	privateKey = privateKey || envPrivateKey;

	const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));

	console.log(gray('gasPrice'), yellow(gasPrice));
	const gas = gasLimit;
	gasPrice = web3.utils.toWei(gasPrice, 'gwei');
	const user = web3.eth.accounts.wallet.add(privateKey);
	const deployer = web3.eth.accounts.wallet.add(envPrivateKey);

	console.log(gray('Using wallet', cyan(user.address)));
	const balance = web3.utils.fromWei(await web3.eth.getBalance(user.address));
	console.log(gray('ETH balance'), yellow(balance));
	let nonce = await web3.eth.getTransactionCount(user.address);
	console.log(gray('Starting at nonce'), yellow(nonce));

	if (balance < '0.01') {
		if (dryRun) {
			console.log(green('[DRY RUN] Sending'), yellow(ethToSeed), green('ETH to address'));
		} else {
			console.log(
				green(`Sending ${yellow(ethToSeed)} ETH to address from`),
				yellow(deployer.address)
			);
			const { transactionHash } = await web3.eth.sendTransaction({
				from: deployer.address,
				to: user.address,
				value: web3.utils.toWei(ethToSeed),
				gas,
				gasPrice,
			});
			console.log(gray(`${etherscanLinkPrefix}/tx/${transactionHash}`));
		}
	}

	const { number: currentBlock } = await web3.eth.getBlock('latest');
	
	if (!isNaN(args[0])) {
		fromBlock = args[0];
	} else {
		if (range > 0) {
			fromBlock = Number(currentBlock) - Number(range);
		}
	}
	
	const getContract = ({ label, source }) =>
		new web3.eth.Contract(
			getSource({ network, contract: source }).abi,
			getTarget({ network, contract: label }).address
		);

	const Oikos = getContract({
		label: 'ProxyERC20',
		source: 'Oikos',
	});

	const Exchanger = getContract({ label: 'Exchanger', source: 'Exchanger' });
	const ExchangeRates = getContract({ label: 'ExchangeRates', source: 'ExchangeRates' });


	const fetchAllEvents = ({ pageSize = 500e3, startingBlock = fromBlock, target }) => {
		const innerFnc = async () => {
			
			console.log(yellow(`Starting block ${startingBlock} Current block ${currentBlock} ${startingBlock > currentBlock} Range ${range}`))
			
			if (startingBlock > currentBlock) {
				return [];
			}
			console.log(gray('-> Fetching page of results from target', yellow(target.options.address)));
			const pageOfResults = await target.getPastEvents('SynthExchange', {
				fromBlock: startingBlock,
				toBlock: startingBlock + pageSize - 1,
			});
			startingBlock += pageSize;
			return [].concat(pageOfResults).concat(await innerFnc());
		};
		return innerFnc();
	};

	let methodology = gray('Loaded');
	let exchanges;

	try {
		if (latest) {
			throw Error('Must fetch latest');
		}
		exchanges = loadExchangesFromFile({ network, fromBlock });
	} catch (err) {
		exchanges = await fetchAllEvents({ target: Oikos });
		saveExchangesToFile({
			network,
			fromBlock,
			exchanges,
		});
		methodology = yellow('Fetched');
	}

	console.log(gray(methodology, yellow(exchanges.length), 'exchanges since block', fromBlock));

	// this would be faster in parallel, but let's do it in serial so we know where we got up to
	// if we have to restart
	const cache = {};
	let debtTally = 0;
	await cleanEntries.restore();

	for (const {
		blockNumber,
		returnValues: { 
			account, 
			toCurrencyKey 
		},
	} of exchanges) {

		if (cache[account + toCurrencyKey]) continue;
		cache[account + toCurrencyKey] = true;
		
		console.log({
			"acct": account, 
			"currencyKey": toCurrencyKey
		})

		try {

			const { reclaimAmount, rebateAmount, numEntries } = await Exchanger.methods
			.settlementOwing(account, toCurrencyKey)
			.call();
			console.log(`Settlement owing ${reclaimAmount} ${rebateAmount} ${numEntries}`)
			/*
					const reclaimAmount = 0;
					const rebateAmount = 0;
					const numEntries = exchanges.length;
			*/
			let _numEntries
			if (numEntries == 0) {
				_numEntries = exchanges.length;
			} else {
				_numEntries = numEntries;
}

		//if (_numEntries > 0) {
			if (numEntries > 0) {
				process.stdout.write(
					gray(
						'Block',
						cyan(blockNumber),
						'processing',
						yellow(account),
						'into',
						yellow(web3.utils.hexToAscii(toCurrencyKey))
					)
				);
	
				const wasReclaimOrRebate = reclaimAmount > 0 || rebateAmount > 0;
				if (showDebt) {
					const valueInUSD = wasReclaimOrRebate
						? web3.utils.fromWei(
								await ExchangeRates.methods
									.effectiveValue(
										toCurrencyKey,
										reclaimAmount > rebateAmount ? reclaimAmount.toString() : rebateAmount.toString(),
										toBytes32('oUSD')
									)
									.call()
						  )
						: 0;
	
					debtTally += Math.round(reclaimAmount > rebateAmount ? -valueInUSD : +valueInUSD);
	
					console.log(
						gray(
							' > Found',
							yellow(numEntries),
							'entries.',
							wasReclaimOrRebate
								? (reclaimAmount > rebateAmount ? green : red)('USD $' + Math.round(valueInUSD))
								: '($0)',
							wasReclaimOrRebate ? 'Tally: ' + debtTally : '',
							valueInUSD > 0 ? 'Settling...' : ''
						)
					);
				} else {
					console.log(
						gray(
							' > Found',
							yellow(numEntries),
							'entries.',
							wasReclaimOrRebate
								? (reclaimAmount > rebateAmount ? green : red)(
										web3.utils.fromWei(reclaimAmount > rebateAmount ? reclaimAmount : rebateAmount)
								  )
								: '($0)',
							'Settling...'
						)
					);
				}
				if (numEntries > 0) {
					if (dryRun) {
						console.log(green(`[DRY RUN] > Invoke settle()`));
					} else {
						console.log(green(`Invoking settle()`));
	
						try {
							Exchanger.methods
							.settle(account, toCurrencyKey)
							.estimateGas({from: user.address,gas: 14000000}, function(error, gasAmount){
								if (error) {
									console.log(red(`Always failing transaction`))
								} else {
									// do not await, just emit using the nonce
									Exchanger.methods
										.settle(account, toCurrencyKey)
										.send({
											from: user.address,
											gas: `${14000000}`,
											gasPrice:5000000000,
											nonce: nonce++,
										})
										.then(({ transactionHash }) =>
											console.log(gray(`${etherscanLinkPrefix}/tx/${transactionHash}`))
										)
										.catch(err => {
											//console.log(err.toString())
											if (err.toString().indexOf("reverted") > -1){
												console.log("tx reverted")
											}
											//console.log(err)
											console.error(
												red('Error settling'),
												yellow(account),
												yellow(web3.utils.hexToAscii(toCurrencyKey)),
												gray(`${etherscanLinkPrefix}/tx/${err.receipt.transactionHash}`)
											);
										});
	
	
								}
							})
						} catch(err) {
							console.log(`Fatal error`)
						}
	
					}
				}
	
			} else if (process.env.DEBUG) {
				console.log(
					gray(
						'Block',
						cyan(blockNumber),
						'processing',
						yellow(account),
						'into',
						yellow(web3.utils.hexToAscii(toCurrencyKey)),
						'> Nothing to settle.'
					)
				);
			}			
		} catch (err) {

			console.log(err)
			await cleanEntries.run(account);

		}





	}
};

module.exports = {
	settle,
	cmd: program =>
		program
			.command('settle')
			.description('Settle all exchanges')
			.option('-d, --show-debt', 'Whether or not to show debt pool impact (requires archive node)')
			.option('-e, --eth-to-seed <value>', 'Amount of ETH to seed', '1')
			.option('-f, --from-block <value>', 'Starting block number to listen to events from')
			.option('-g, --gas-price <value>', 'Gas price in GWEI', '1')
			.option('-l, --gas-limit <value>', 'Gas limit', parseInt, 150e3)
			.option('-v, --private-key <value>', 'Provide private key to settle from given account')
			.option('-n, --network <value>', 'The network to run off.', x => x.toLowerCase(), 'testnet')
			.option('-a, --latest', 'Always fetch the latest list of transactions')
			.option('-r, --range  <value>', 'Block range')
			.option(
				'-x, --dry-run',
				'If enabled, will not run any transactions but merely report on them.'
			)
			.action(async (...args) => {
				const parsedArgs = minimist(process.argv.slice(2))
 
				try {
					await settle(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}

			}),};
