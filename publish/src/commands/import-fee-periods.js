'use strict';

const path = require('path');
const fs = require('fs');
const w3utils = require('web3-utils');
const Web3 = require('web3');
const { red, gray, green, yellow } = require('chalk');

const {
	getVersions,
	constants: { CONFIG_FILENAME, DEPLOYMENT_FILENAME },
} = require('../../..');

const DEFAULTS = {
	gasPrice: '1',
	gasLimit: 1.5e6, // 1.5m
	network: 'testnet',
};

const {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	stringify,
} = require('../util');

const pathToLocal = name => path.join(__dirname, `${name}.json`);

const saveFeePeriodsToFile = ({ network, feePeriods, sourceContractAddress }) => {
	fs.writeFileSync(
		pathToLocal(`recent-feePeriods-${network}-${sourceContractAddress}`),
		stringify(feePeriods)
	);
};

const importFeePeriods = async ({
	deploymentPath,
	network = DEFAULTS.network,
	gasPrice = DEFAULTS.gasPrice,
	gasLimit = DEFAULTS.gasLimit,
	sourceContractAddress,
	privateKey,
	yes,
	override,
	skipTimeCheck = false,
}) => {
	ensureNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const { deployment } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const web3 = new Web3(new Web3.providers.HttpProvider(providerUrl));
	web3.eth.accounts.wallet.add(privateKey);
	const account = web3.eth.accounts.wallet[0].address;
	console.log(gray(`Using account with public key ${account}`));

	let { address: targetContractAddress, source } = deployment.targets['FeePool'];

	/*if (!sourceContractAddress) {
		// load from versions file if not supplied
		const feePoolVersions = getVersions({ network, byContract: true }).FeePool;
		console.log(feePoolVersions)
		// it will be the last entry in the versions file if a release hasn't occurred, or the second last if it has
		// note: this is brittle - it assumes the versions file is ordered correctly (which it is
		// but some other engineer may not realize this assumption and modify versions.json directly and
		// break the assumption).
		const [secondLastEntry, lastEntry] = feePoolVersions.slice(-2);
		console.log(lastEntry)
		if (lastEntry.address !== targetContractAddress) {
			sourceContractAddress = lastEntry.address;
		} else if (secondLastEntry.address !== targetContractAddress) {
			sourceContractAddress = targetContractAddress.address;
		} else {
			throw Error('Cannot determine which is the last version of FeePool for the network');
		}
	} else if (!w3utils.isAddress(sourceContractAddress)) {
		throw Error(
			'Invalid address detected for source (please check your inputs): ',
			sourceContractAddress
		);
	}*/
	const feePoolVersions = getVersions({ network, byContract: true }).FeePool;

	const entry = feePoolVersions.slice(-2);
	sourceContractAddress = entry.address;
	
	//console.log(entry)
	//const feePeriods = [];

	const { abi } = deployment.sources[source];
	//if (sourceContractAddress.toLowerCase() === targetContractAddress.toLowerCase()) {
	//	throw Error(
	//		'Cannot use same FeePool address as the source and the target. Check your source input.'
	//	);
	//} else {
		console.log(gray(`Reading from old FeePool at: ${"0x4a7644B4b3ae6E4e2c53D01a39E7C4afA25061aF"}`));
		console.log(gray(`Importing into new FeePool at: ${targetContractAddress}`));
	//}
	const sourceContract = new web3.eth.Contract(abi, "0x4a7644B4b3ae6E4e2c53D01a39E7C4afA25061aF");
	const targetContract = new web3.eth.Contract(abi, targetContractAddress);

	const feePeriodLength = await sourceContract.methods.FEE_PERIOD_LENGTH().call();

	
	// Check sources
	for (let i = 0; i <= feePeriodLength - 1; i++) {
		const period = await sourceContract.methods.recentFeePeriods(i).call();
		if (!skipTimeCheck) {
			if (period.feePeriodId === '0') {
				throw Error(
					`Fee period at index ${i} has NOT been set. Are you sure this is the right FeePool source? ${etherscanLinkPrefix}/address/${sourceContractAddress} `
				);
			} else if (i === 0 && period.startTime < Date.now() / 1000 - 3600 * 24 * 7) {
				throw Error(
					`The initial fee period is more than one week ago - this is likely an error. ` +
						`Please check to make sure you are using the correct FeePool source (this should ` +
						`be the one most recently replaced). Given: ${etherscanLinkPrefix}/address/${sourceContractAddress}`
				);
			}
		}

		// remove redundant index keys (returned from struct calls)
		Object.keys(period)
			.filter(key => /^[0-9]+$/.test(key))
			.forEach(key => delete period[key]);
		feePeriods.push(period);
		console.log(
			gray(`loaded feePeriod ${i} from FeePool (startTime: ${new Date(period.startTime * 1000)})`)
		);
	}

	// Check target does not have existing periods
	if (!override) {
		for (let i = 0; i < feePeriodLength; i++) {
			const period = await targetContract.methods.recentFeePeriods(i).call();
			// ignore any initial entry where feePeriodId is 1 as this is created by the FeePool constructor
			if (period.feePeriodId !== '1' && period.startTime !== '0') {
				//throw Error(
				//	`The new target FeePool already has imported fee periods (one or more entries has ` +
				//		`startTime as 0. Please check to make sure you are using the latest FeePool ` +
				//		`(this should be the most recently deployed). Given: ${etherscanLinkPrefix}/address/${targetContractAddress}`
				//);
			}
		}
	} else {
		console.log(
			gray('Warning: Setting target to override - ignoring existing FeePool periods in target!')
		);
	}

	console.log(gray('The fee periods to import over are as follows:'));
	console.log(gray(stringify(feePeriods)));

	console.log(gray(`Gas Price: ${gasPrice} gwei`));

	if (network !== 'local') {
		saveFeePeriodsToFile({ network, feePeriods, sourceContractAddress });
	}
/*
	const feePeriods = [
		{
			"feePeriodId": "16",
			"startingDebtIndex": "2367",
			"startTime": "1625102573",
			"feesToDistribute": "101807661981055381708",
			"feesClaimed": "0",
			"rewardsToDistribute": "0",
			"rewardsClaimed": "0"
		},
		{
			"feePeriodId": "15",
			"startingDebtIndex": "2291",
			"startTime": "1624497723",
			"feesToDistribute": "358070410770760894428",
			"feesClaimed": "0",
			"rewardsToDistribute": "524431930296153806249999",
			"rewardsClaimed": "0"
		},
		{
			"feePeriodId": "14",
			"startingDebtIndex": "2243",
			"startTime": "1623890529",
			"feesToDistribute": "381208625605756525790",
			"feesClaimed": "65196178837943350041",
			"rewardsToDistribute": "1755866929929012116988565",
			"rewardsClaimed": "175144943461539444648625"
		}
	]
	
	
	let index = 0;
	for (const feePeriod of feePeriods) {
		console.log('Fee period to import is as follows:');
		console.log(stringify(feePeriod));

		if (!yes) {
			try {
				await confirmAction(
					yellow(
						`Do you want to continue importing this fee period in index position ${index} (y/n) ?`
					)
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		const importArgs = [
			index,
			feePeriod.feePeriodId,
			feePeriod.startingDebtIndex,
			feePeriod.startTime,
			feePeriod.feesToDistribute,
			feePeriod.feesClaimed,
			feePeriod.rewardsToDistribute,
			feePeriod.rewardsClaimed,
		];
		console.log(yellow(`Attempting action FeePool.importFeePeriod(${importArgs})`));
		const { transactionHash } = await targetContract.methods.importFeePeriod(...importArgs).send({
			from: account,
			gasLimit: Number(gasLimit),
			gasPrice: w3utils.toWei("10", 'gwei'),
		});
		index++;

		console.log(
			green(
				`Successfully emitted importFeePeriod with transaction: ${etherscanLinkPrefix}/tx/${transactionHash}`
			)
		);
	}
*/
	console.log(gray('Action complete.'));
};

module.exports = {
	importFeePeriods,
	cmd: program =>
		program
			.command('import-fee-periods')
			.description('Import fee periods')
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file (${CONFIG_FILENAME}) and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option('-l, --gas-limit <value>', 'Gas limit', parseInt, DEFAULTS.gasLimit)
			.option('-s, --source-contract-address <value>', 'The Fee Pool source contract address')
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-o, --override',
				'Override fee periods in target - use when resuming an import process that failed or was cancelled partway through'
			)
			.option(
				'-t, --skip-time-check',
				"Do not do a time check - I sure hope you know what you're doing"
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')

			.action(async (...args) => {
				try {
					await importFeePeriods(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}
			}),
};
