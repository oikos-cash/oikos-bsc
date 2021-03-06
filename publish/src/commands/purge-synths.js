'use strict';

const { gray, yellow, red, cyan } = require('chalk');
const Web3 = require('web3');
const w3utils = require('web3-utils');
const axios = require('axios');

const { CONFIG_FILENAME, DEPLOYMENT_FILENAME } = require('../constants');

const {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	performTransactionalStep,
} = require('../util');

const { toBytes32 } = require('../../../.');

const DEFAULTS = {
	network: 'kovan',
	gasLimit: 3e6,
	gasPrice: '1',
};

const purgeSynths = async ({
	network = DEFAULTS.network,
	deploymentPath,
	gasPrice = DEFAULTS.gasPrice,
	gasLimit = DEFAULTS.gasLimit,
	synthsToPurge = [],
	yes,
	privateKey,
	addresses = [],
}) => {
	ensureNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const { synths, deployment } = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	if (synthsToPurge.length < 1) {
		console.log(gray('No synths provided. Please use --synths-to-remove option'));
		return;
	}

	// sanity-check the synth list
	for (const synth of synthsToPurge) {
		if (synths.filter(({ name }) => name === synth).length < 1) {
			console.error(red(`Synth ${synth} not found!`));
			process.exitCode = 1;
			return;
		} else if (['oUSD'].indexOf(synth) >= 0) {
			console.error(red(`Synth ${synth} cannot be purged`));
			process.exitCode = 1;
			return;
		}
	}

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
	console.log(gray(`Using gas of ${gasPrice} GWEI with a max of ${gasLimit}`));

	if (!yes) {
		try {
			await confirmAction(
				cyan(
					`${yellow(
						'⚠ WARNING'
					)}: This action will purge the following synths from the Oikos contract on ${network}:\n- ${synthsToPurge.join(
						'\n- '
					)}`
				) + '\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	const { address: oikosAddress, source } = deployment.targets['Oikos'];
	const { abi: oikosABI } = deployment.sources[source];
	const Oikos = new web3.eth.Contract(oikosABI, oikosAddress);

	for (const currencyKey of synthsToPurge) {
		const { address: synthAddress, source: synthSource } = deployment.targets[
			`Synth${currencyKey}`
		];
		console.log(
			gray('For', currencyKey, 'using source of', synthSource, 'at address', synthAddress)
		);
		const { abi: synthABI } = deployment.sources[synthSource];
		const Synth = new web3.eth.Contract(synthABI, synthAddress);
		const { address: proxyAddress } = deployment.targets[`Proxy${currencyKey}`];

		const currentSynthInSNX = await Oikos.methods.synths(toBytes32(currencyKey)).call();

		if (synthAddress !== currentSynthInSNX) {
			console.error(
				red(
					`Synth address in Oikos for ${currencyKey} is different from what's deployed in Oikos to the local ${DEPLOYMENT_FILENAME} of ${network} \ndeployed: ${yellow(
						currentSynthInSNX
					)}\nlocal:    ${yellow(synthAddress)}`
				)
			);
			process.exitCode = 1;
			return;
		}

		// step 1. fetch all holders via ethplorer api
		if (network === 'mainnet') {
			const topTokenHoldersUrl = `http://api.ethplorer.io/getTopTokenHolders/${proxyAddress}`;
			const response = await axios.get(topTokenHoldersUrl, {
				params: {
					apiKey: process.env.ETHPLORER_API_KEY || 'freekey',
					limit: 1000,
				},
			});

			const topTokenHolders = response.data.holders.map(({ address }) => address);
			console.log(gray(`Found ${topTokenHolders.length} holders of ${currencyKey}`));
			addresses = topTokenHolders;
		}

		const totalSupplyBefore = w3utils.fromWei(await Synth.methods.totalSupply().call());

		if (Number(totalSupplyBefore) === 0) {
			console.log(gray('Total supply is 0, exiting.'));
			return;
		} else {
			console.log(gray('Total supply before purge is:', totalSupplyBefore));
		}

		// step 2. start the purge
		await performTransactionalStep({
			account,
			contract: `Synth${currencyKey}`,
			target: Synth,
			write: 'purge',
			writeArg: [addresses], // explicitly pass array of args so array not splat as params
			gasLimit,
			gasPrice,
			etherscanLinkPrefix,
		});

		// step 3. confirmation
		const totalSupply = w3utils.fromWei(await Synth.methods.totalSupply().call());
		if (Number(totalSupply) > 0) {
			console.log(
				yellow(
					`⚠⚠⚠ WARNING: totalSupply is not 0 after purge of ${currencyKey}. It is ${totalSupply}. ` +
						`Were there 100 or 1000 holders noted above? If so then we have likely hit the tokenHolder ` +
						`API limit; another purge is required for this synth.`
				)
			);
		}
	}
};

module.exports = {
	purgeSynths,
	cmd: program =>
		program
			.command('purge-synths')
			.description('Purge a number of synths from the system')
			.option(
				'-a, --addresses <value>',
				'The list of holder addresses (use in testnets when Ethplorer API does not return holders)',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option('-l, --gas-limit <value>', 'Gas limit', DEFAULTS.gasLimit)
			.option(
				'-n, --network [value]',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-v, --private-key [value]',
				'The private key to transact with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-s, --synths-to-purge <value>',
				'The list of synths to purge',
				(val, memo) => {
					memo.push(val);
					return memo;
				},
				[]
			)
			.action(purgeSynths),
};
