'use strict';

const path = require('path');
const fs = require('fs');
const { gray, green, yellow, redBright, red } = require('chalk');
const { table } = require('table');
const w3utils = require('web3-utils');
const Deployer = require('../Deployer');
const { loadCompiledFiles, getLatestSolTimestamp } = require('../solidity');
const checkAggregatorPrices = require('../check-aggregator-prices');

const {
	ensureNetwork,
	ensureDeploymentPath,
	loadAndCheckRequiredSources,
	loadConnections,
	confirmAction,
	performTransactionalStep,
	stringify,
} = require('../util');

const {
	toBytes32,
	constants: {
		BUILD_FOLDER,
		CONFIG_FILENAME,
		CONTRACTS_FOLDER,
		SYNTHS_FILENAME,
		DEPLOYMENT_FILENAME,
		ZERO_ADDRESS,
		inflationStartTimestampInSecs,
	},
} = require('../../../.');

const parameterNotice = props => {
	console.log(gray('-'.repeat(50)));
	console.log('Please check the following parameters are correct:');
	console.log(gray('-'.repeat(50)));

	Object.entries(props).forEach(([key, val]) => {
		console.log(gray(key) + ' '.repeat(30 - key.length) + redBright(val));
	});

	console.log(gray('-'.repeat(50)));
};

const DEFAULTS = {
	gasPrice: '1',
	methodCallGasLimit: 250e3, // 250k
	contractDeploymentGasLimit: 6.9e6, // TODO split out into seperate limits for different contracts, Proxys, Synths, Oikos
	network: 'testnet',
	buildPath: path.join(__dirname, '..', '..', '..', BUILD_FOLDER),
};

const deploy = async ({
	addNewSynths,
	gasPrice = DEFAULTS.gasPrice,
	methodCallGasLimit = DEFAULTS.methodCallGasLimit,
	contractDeploymentGasLimit = DEFAULTS.contractDeploymentGasLimit,
	network = DEFAULTS.network,
	buildPath = DEFAULTS.buildPath,
	deploymentPath,
	oracleExrates,
	privateKey,
	yes,
	dryRun = false,
	forceUpdateInverseSynthsOnTestnet = false,
} = {}) => {
	ensureNetwork(network);
	ensureDeploymentPath(deploymentPath);

	const {
		config,
		configFile,
		synths,
		deployment,
		deploymentFile,
		ownerActions,
		ownerActionsFile,
	} = loadAndCheckRequiredSources({
		deploymentPath,
		network,
	});

	console.log(
		gray('Checking all contracts not flagged for deployment have addresses in this network...')
	);
	const missingDeployments = Object.keys(config).filter(name => {
		return !config[name].deploy && (!deployment.targets[name] || !deployment.targets[name].address);
	});

	if (missingDeployments.length) {
		throw Error(
			`Cannot use existing contracts for deployment as addresses not found for the following contracts on ${network}:\n` +
				missingDeployments.join('\n') +
				'\n' +
				gray(`Used: ${deploymentFile} as source`)
		);
	}

	console.log(gray('Loading the compiled contracts locally...'));
	const { earliestCompiledTimestamp, compiled } = loadCompiledFiles({ buildPath });

	// now get the latest time a Solidity file was edited
	const latestSolTimestamp = getLatestSolTimestamp(CONTRACTS_FOLDER);

	// now clone these so we can update and write them after each deployment but keep the original
	// flags available
	const updatedConfig = JSON.parse(JSON.stringify(config));

	const { providerUrl, privateKey: envPrivateKey, etherscanLinkPrefix } = loadConnections({
		network,
	});

	// allow local deployments to use the private key passed as a CLI option
	if (network !== 'local' || !privateKey) {
		privateKey = envPrivateKey;
	}

	const deployer = new Deployer({
		compiled,
		config,
		gasPrice,
		methodCallGasLimit,
		contractDeploymentGasLimit,
		deployment,
		privateKey,
		providerUrl,
	});

	const { account } = deployer;

	const getExistingContract = ({ contract }) => {
		const { address, source } = deployment.targets[contract];
		const { abi } = deployment.sources[source];

		return deployer.getContract({
			address,
			abi,
		});
	};

	let currentOikosSupply;
	let currentOikosPrice;
	let oldExrates;
	let currentLastMintEvent;
	let currentWeekOfInflation;
	let systemSuspended = false;
	let systemSuspendedReason;

	try {
		const oldOikos = getExistingContract({ contract: 'Oikos' });
		currentOikosSupply = await oldOikos.methods.totalSupply().call();
		// inflationSupplyToDate = total supply - 100m
		const inflationSupplyToDate = w3utils
			.toBN(currentOikosSupply)
			.sub(w3utils.toBN(w3utils.toWei((100e6).toString())));

		// current weekly inflation 75m / 52
		const weeklyInflation = w3utils.toBN(w3utils.toWei((75e6 / 52).toString()));
		currentWeekOfInflation = inflationSupplyToDate.div(weeklyInflation);

		// Check result is > 0 else set to 0 for currentWeek
		currentWeekOfInflation = currentWeekOfInflation.gt(w3utils.toBN('0'))
			? currentWeekOfInflation.toNumber()
			: 0;

		// Calculate lastMintEvent as Inflation start date + number of weeks issued * secs in weeks
		const mintingBuffer = 86400;
		const secondsInWeek = 604800;
		const inflationStartDate = 1590969600;
		currentLastMintEvent =
			inflationStartDate + currentWeekOfInflation * secondsInWeek + mintingBuffer;
	} catch (err) {
		if (/*network === 'local' ||*/ network === "testnet" ) {
			currentOikosSupply = w3utils.toWei((100e6).toString());
			currentWeekOfInflation = 0;
			currentLastMintEvent = 0;
		} else {
			console.error(
				red(
					`Network ${network} Cannot connect to existing Oikos contract. Please double check the deploymentPath is correct for the network allocated`
				)
			);
			process.exitCode = 1;
			return;
		}
	}

	try {
		oldExrates = getExistingContract({ contract: 'ExchangeRates' });
		currentOikosPrice = await oldExrates.methods.rateForCurrency(toBytes32('OKS')).call();
		if (!oracleExrates) {
			oracleExrates = await oldExrates.methods.oracle().call();
		}
	} catch (err) {
		if (network === 'local' || network === "testnet") {
			currentOikosPrice = w3utils.toWei('0.2');
			oracleExrates = account;
			oldExrates = undefined; // unset to signify that a fresh one will be deployed
		} else {
			console.error(
				red(
					'Cannot connect to existing ExchangeRates contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;
		}
	}

	try {
		const oldSystemStatus = getExistingContract({ contract: 'SystemStatus' });

		const systemSuspensionStatus = await oldSystemStatus.methods.systemSuspension().call();

		systemSuspended = systemSuspensionStatus.suspended;
		systemSuspendedReason = systemSuspensionStatus.reason;
	} catch (err) {
		if (network !== 'local') {
			/*console.error(
				red(
					'Cannot connect to existing SystemStatus contract. Please double check the deploymentPath is correct for the network allocated'
				)
			);
			process.exitCode = 1;
			return;*/
		}
	}

	for (const address of [account, oracleExrates]) {
		if (!w3utils.isAddress(address)) {
			console.error(red('Invalid address detected (please check your inputs):', address));
			process.exitCode = 1;
			return;
		}
	}

	const newSynthsToAdd = synths
		.filter(({ name }) => !config[`Synth${name}`])
		.map(({ name }) => name);

	let aggregatedPriceResults = 'N/A';

	/*if (oldExrates && network !== 'local') {
		const padding = '\n\t\t\t\t';
		const aggResults = await checkAggregatorPrices({
			network,
			providerUrl,
			synths,
			oldExrates,
		});
		aggregatedPriceResults = padding + aggResults.join(padding);
	}*/

	parameterNotice({
		'Dry Run': dryRun ? green('true') : yellow('⚠ NO'),
		Network: network,
		'Gas price to use': `${gasPrice} GWEI`,
		'Deployment Path': new RegExp(network, 'gi').test(deploymentPath)
			? deploymentPath
			: yellow('⚠⚠⚠ cant find network name in path. Please double check this! ') + deploymentPath,
		'Local build last modified': `${new Date(earliestCompiledTimestamp)} ${yellow(
			((new Date().getTime() - earliestCompiledTimestamp) / 60000).toFixed(2) + ' mins ago'
		)}`,
		'Last Solidity update':
			new Date(latestSolTimestamp) +
			(latestSolTimestamp > earliestCompiledTimestamp
				? yellow(' ⚠⚠⚠ this is later than the last build! Is this intentional?')
				: green(' ✅')),
		'Add any new synths found?': addNewSynths
			? green('✅ YES\n\t\t\t\t') + newSynthsToAdd.join(', ')
			: yellow('⚠ NO'),
		'Deployer account:': account,
		'Oikos totalSupply': `${Math.round(w3utils.fromWei(currentOikosSupply) / 1e6)}m`,
		'ExchangeRates Oracle': oracleExrates,
		'Last Mint Event': `${currentLastMintEvent} (${new Date(currentLastMintEvent * 1000)})`,
		'Current Weeks Of Inflation': currentWeekOfInflation,
		'Aggregated Prices': aggregatedPriceResults,
		'System Suspended': systemSuspended
			? green(' ✅', 'Reason:', systemSuspendedReason)
			: yellow('⚠ NO'),
	});

	if (!yes) {
		try {
			await confirmAction(
				yellow(
					`⚠⚠⚠ WARNING: This action will deploy the following contracts to ${network}:\n${Object.entries(
						config
					)
						.filter(([, { deploy }]) => deploy)
						.map(([contract]) => contract)
						.join(', ')}` + `\nIt will also set proxy targets and add synths to Oikos.\n`
				) +
					gray('-'.repeat(50)) +
					'\nDo you want to continue? (y/n) '
			);
		} catch (err) {
			console.log(gray('Operation cancelled'));
			return;
		}
	}

	console.log(gray(`Starting deployment to ${network.toUpperCase()} via Infura...`));
	const newContractsDeployed = [];
	// force flag indicates to deploy even when no config for the entry (useful for new synths)
	const deployContract = async ({ name, source = name, args, deps, force = false }) => {
		const deployedContract = await deployer.deploy({ name, source, args, deps, force, dryRun });
		if (!deployedContract) {
			return;
		}
		const { address } = deployedContract.options;

		let timestamp = new Date();
		let txn = '';
		if (config[name] && !config[name].deploy) {
			// deploy is false, so we reused a deployment, thus lets grab the details that already exist
			timestamp = deployment.targets[name].timestamp;
			txn = deployment.targets[name].txn;
		}
		// now update the deployed contract information
		deployment.targets[name] = {
			name,
			address,
			source,
			link: `https://${network !== 'bsc' ? network + '.' : ''}etherscan.io/address/${
				deployer.deployedContracts[name].options.address
			}`,
			timestamp,
			txn,
			network,
		};
		if (deployedContract.options.deployed) {
			// track the new source and bytecode
			deployment.sources[source] = {
				bytecode: compiled[source].evm.bytecode.object,
				abi: compiled[source].abi,
			};
			// add to the list of deployed contracts for later reporting
			newContractsDeployed.push({
				name,
				address,
			});
		}
		if (!dryRun) {
			fs.writeFileSync(deploymentFile, stringify(deployment));
		}

		// now update the flags to indicate it no longer needs deployment,
		// ignoring this step for local, which wants a full deployment by default
		if (network !== 'local' && !dryRun) {
			updatedConfig[name] = { deploy: false };
			fs.writeFileSync(configFile, stringify(updatedConfig));
		}

		//console.log(newContractsDeployed)

		return deployedContract;
	};

	const runStep = async opts =>
		performTransactionalStep({
			gasLimit: methodCallGasLimit, // allow overriding of gasLimit
			...opts,
			account,
			gasPrice,
			etherscanLinkPrefix,
			ownerActions,
			ownerActionsFile,
			dryRun,
		});

	await deployContract({
		name: 'SafeDecimalMath',
	});

	await deployContract({
		name: 'Math',
	});

	const addressOf = c => (c ? c.options.address : '');

	const addressResolver = await deployContract({
		name: 'AddressResolver',
		args: [account],
	});

	const readProxyForResolver = await deployContract({
		name: 'ReadProxyAddressResolver',
		source: 'ReadProxy',
		args: [account],
	});

	const resolverAddress = addressOf(addressResolver);

	if (addressResolver && readProxyForResolver) {
		await runStep({
			contract: 'ReadProxyAddressResolver',
			target: readProxyForResolver,
			read: 'target',
			expected: input => input === resolverAddress,
			write: 'setTarget',
			writeArg: resolverAddress,
		});
	}

	let systemStatus = await deployContract({
		name: 'SystemStatus',
		args: [account],
	});

	const exchangeRates = await deployContract({
		name: 'ExchangeRates',
		args: [account, oracleExrates, [toBytes32('OKS')], [currentOikosPrice]],
	});

	const rewardEscrow = await deployContract({
		name: 'RewardEscrow',
		args: [account, ZERO_ADDRESS, ZERO_ADDRESS],
	});

	const oikosEscrow = await deployContract({
		name: 'OikosEscrow',
		args: [account, ZERO_ADDRESS],
	});

	const oikosEscrowVx = await deployContract({
		name: 'OikosEscrowVx',
		args: [account, ZERO_ADDRESS],
	});

	const oikosState = await deployContract({
		name: 'OikosState',
		args: [account, account],
	});

	const proxyFeePool = await deployContract({
		name: 'ProxyFeePool',
		source: 'Proxy',
		args: [account],
	});

	const OikosDebtShare = await deployContract({
		name: 'OikosDebtShare',
		args: [account, resolverAddress],
	});


	const delegateApprovalsEternalStorage = await deployContract({
		name: 'DelegateApprovalsEternalStorage',
		source: 'EternalStorage',
		args: [account, ZERO_ADDRESS],
	});

	const delegateApprovals = await deployContract({
		name: 'DelegateApprovals',
		args: [account, addressOf(delegateApprovalsEternalStorage)],
	});

	if (delegateApprovals && delegateApprovalsEternalStorage) {
		await runStep({
			contract: 'EternalStorage',
			target: delegateApprovalsEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(delegateApprovals),
			write: 'setAssociatedContract',
			writeArg: addressOf(delegateApprovals),
		});
	}

	const liquidations = await deployContract({
		name: 'Liquidations',
		args: [account, resolverAddress],
	});

	const eternalStorageLiquidations = await deployContract({
		name: 'EternalStorageLiquidations',
		source: 'EternalStorage',
		args: [account, addressOf(liquidations)],
	});

	if (liquidations && eternalStorageLiquidations) {
		await runStep({
			contract: 'EternalStorageLiquidations',
			target: eternalStorageLiquidations,
			read: 'associatedContract',
			expected: input => input === addressOf(liquidations),
			write: 'setAssociatedContract',
			writeArg: addressOf(liquidations),
		});
	}

	const feePoolEternalStorage = await deployContract({
		name: 'FeePoolEternalStorage',
		args: [account, ZERO_ADDRESS],
	});

	const feePool = await deployContract({
		name: 'FeePool',
		deps: ['ProxyFeePool', 'AddressResolver'],
		args: [addressOf(proxyFeePool), account, resolverAddress],
	});

	if (proxyFeePool && feePool) {
		await runStep({
			contract: 'ProxyFeePool',
			target: proxyFeePool,
			read: 'target',
			expected: input => input === addressOf(feePool),
			write: 'setTarget',
			writeArg: addressOf(feePool),
		});
	}

	if (feePoolEternalStorage && feePool) {
		await runStep({
			contract: 'FeePoolEternalStorage',
			target: feePoolEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(feePool),
			write: 'setAssociatedContract',
			writeArg: addressOf(feePool),
		});
	}

	if (feePool) {
		// Set FeePool.targetThreshold to 1%
		const targetThreshold = '0.01';
		await runStep({
			contract: 'FeePool',
			target: feePool,
			read: 'targetThreshold',
			expected: input => input === w3utils.toWei(targetThreshold),
			write: 'setTargetThreshold',
			writeArg: (targetThreshold * 100).toString(), // arg expects percentage as uint
		});
	}

	const feePoolState = await deployContract({
		name: 'FeePoolState',
		deps: ['FeePool'],
		args: [account, addressOf(feePool)],
	});

	if (feePool && feePoolState) {
		// Rewire feePoolState if there is a feePool upgrade
		await runStep({
			contract: 'FeePoolState',
			target: feePoolState,
			read: 'feePool',
			expected: input => input === addressOf(feePool),
			write: 'setFeePool',
			writeArg: addressOf(feePool),
		});
	}

	const rewardsDistribution = await deployContract({
		name: 'RewardsDistribution',
		deps: ['RewardEscrow', 'ProxyFeePool'],
		args: [
			account, // owner
			ZERO_ADDRESS, // authority (oikos)
			ZERO_ADDRESS, // Oikos Proxy
			addressOf(rewardEscrow),
			addressOf(proxyFeePool),
		],
	});

	// constructor(address _owner, uint _lastMintEvent, uint _currentWeek)
	const supplySchedule = await deployContract({
		name: 'SupplySchedule',
		args: [account, currentLastMintEvent, currentWeekOfInflation],
	});

	// New Oikos proxy.
	const proxyERC20Oikos = await deployContract({
		name: 'ProxyERC20',
		args: [account],
	});

	const tokenStateOikos = await deployContract({
		name: 'TokenStateOikos',
		source: 'TokenState',
		args: [account, account],
	});

	const oikos = await deployContract({
		name: 'Oikos',
		deps: ['ProxyERC20', 'TokenStateOikos', 'AddressResolver'],
		args: [
			addressOf(proxyERC20Oikos),
			addressOf(tokenStateOikos),
			account,
			currentOikosSupply,
			resolverAddress,
		],
	});

	const proxyOikos = await deployContract({
		name: 'ProxyOikos',
		source: 'Proxy',
		args: [account],
	});

	if (oikos && proxyERC20Oikos) {
		await runStep({
			contract: 'ProxyERC20',
			target: proxyERC20Oikos,
			read: 'target',
			expected: input => input === addressOf(oikos),
			write: 'setTarget',
			writeArg: addressOf(oikos),
		});
		await runStep({
			contract: 'Oikos',
			target: oikos,
			read: 'proxy',
			expected: input => input === addressOf(proxyERC20Oikos),
			write: 'setProxy',
			writeArg: addressOf(proxyERC20Oikos),
		});
	}

	// Old Oikos proxy based off Proxy.sol: this has been deprecated.
	// To be removed after May 30, 2020:
	// https://docs.oikos.io/integrations/guide/#proxy-deprecation
	const ProxyERC20Oikos = await deployContract({
		name: 'ProxyERC20Oikos',
		source: 'Proxy',
		args: [account],
	});
	if (ProxyERC20Oikos && oikos) {
		await runStep({
			contract: 'ProxyERC20Oikos',
			target: ProxyERC20Oikos,
			read: 'target',
			expected: input => input === addressOf(oikos),
			write: 'setTarget',
			writeArg: addressOf(oikos),
		});
		await runStep({
			contract: 'Oikos',
			target: oikos,
			read: 'integrationProxy',
			expected: input => input === addressOf(ProxyERC20Oikos),
			write: 'setIntegrationProxy',
			writeArg: addressOf(ProxyERC20Oikos),
		});
	}

	const exchanger = await deployContract({
		name: 'Exchanger',
		deps: ['AddressResolver'],
		args: [account, resolverAddress],
	});

	const exchangeState = await deployContract({
		name: 'ExchangeState',
		deps: ['Exchanger'],
		args: [account, addressOf(exchanger)],
	});

	if (exchanger && exchangeState) {
		// The exchangeState contract has Exchanger as it's associated contract
		await runStep({
			contract: 'ExchangeState',
			target: exchangeState,
			read: 'associatedContract',
			expected: input => input === exchanger.options.address,
			write: 'setAssociatedContract',
			writeArg: exchanger.options.address,
		});
	}

	// only reset token state if redeploying
	if (tokenStateOikos && config['TokenStateOikos'].deploy) {
		const initialIssuance = w3utils.toWei('100000000');
		await runStep({
			contract: 'TokenStateOikos',
			target: tokenStateOikos,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
		});
	}

	if (tokenStateOikos && oikos) {
		await runStep({
			contract: 'TokenStateOikos',
			target: tokenStateOikos,
			read: 'associatedContract',
			expected: input => input === addressOf(oikos),
			write: 'setAssociatedContract',
			writeArg: addressOf(oikos),
		});
	}

	const debtCache =  await deployContract({
		name: 'DebtCache',
		source: /*useOvm ? 'RealtimeDebtCache' : */ 'DebtCache',
		deps: ['AddressResolver'],
		args: [account, addressOf(readProxyForResolver)],
	});

	const issuer = await deployContract({
		name: 'Issuer',
		deps: ['AddressResolver'],
		args: [account, addressOf(addressResolver)],
	});

	const issuerAddress = addressOf(issuer);

	const issuanceEternalStorage = await deployContract({
		name: 'IssuanceEternalStorage',
		deps: ['Issuer'],
		args: [account, issuerAddress],
	});

	if (issuanceEternalStorage && issuer) {
		await runStep({
			contract: 'IssuanceEternalStorage',
			target: issuanceEternalStorage,
			read: 'associatedContract',
			expected: input => input === issuerAddress,
			write: 'setAssociatedContract',
			writeArg: issuerAddress,
		});
	}

	if (oikosState && issuer) {
		// The OikosState contract has Issuer as it's associated contract (after v2.19 refactor)
		await runStep({
			contract: 'OikosState',
			target: oikosState,
			read: 'associatedContract',
			expected: input => input === issuerAddress,
			write: 'setAssociatedContract',
			writeArg: issuerAddress,
		});
	}

	if (oikosEscrow) {
		await deployContract({
			name: 'EscrowChecker',
			deps: ['OikosEscrow'],
			args: [addressOf(oikosEscrow)],
		});
	}

	if (oikosEscrowVx) {
		await deployContract({
			name: 'EscrowChecker',
			deps: ['OikosEscrowVx'],
			args: [addressOf(oikosEscrowVx)],
		});
	}

	if (rewardEscrow && oikos) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'oikos',
			expected: input => input === addressOf(oikos),
			write: 'setOikos',
			writeArg: addressOf(oikos),
		});
	}

	if (rewardEscrow && feePool) {
		await runStep({
			contract: 'RewardEscrow',
			target: rewardEscrow,
			read: 'feePool',
			expected: input => input === addressOf(feePool),
			write: 'setFeePool',
			writeArg: addressOf(feePool),
		});
	}

	if (supplySchedule && oikos) {
		/*await runStep({
			contract: 'SupplySchedule',
			target: supplySchedule,
			read: 'oikosProxy',
			expected: input => input === addressOf(ProxyERC20Oikos),
			write: 'setOikosProxy',
			writeArg: addressOf(ProxyERC20Oikos),
		});*/
	}

	if (oikos && rewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'authority',
			expected: input => input === addressOf(oikos),
			write: 'setAuthority',
			writeArg: addressOf(oikos),
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: rewardsDistribution,
			read: 'oikosProxy',
			expected: input => input === addressOf(proxyERC20Oikos),
			write: 'setOikosProxy',
			writeArg: addressOf(proxyERC20Oikos),
		});
	}

	// ----------------
	// Binary option market factory and manager setup
	// ----------------

	await deployContract({
		name: 'BinaryOptionMarketFactory',
		args: [account, resolverAddress],
		deps: ['AddressResolver'],
	});

	const day = 24 * 60 * 60;
	const maxOraclePriceAge = 120 * 60; // Price updates are accepted from up to two hours before maturity to allow for delayed chainlink heartbeats.
	const expiryDuration = 26 * 7 * day; // Six months to exercise options before the market is destructible.
	const maxTimeToMaturity = 730 * day; // Markets may not be deployed more than two years in the future.
	const creatorCapitalRequirement = w3utils.toWei('1000'); // 1000 oUSD is required to create a new market.
	const creatorSkewLimit = w3utils.toWei('0.05'); // Market creators must leave 5% or more of their position on either side.
	const poolFee = w3utils.toWei('0.008'); // 0.8% of the market's value goes to the pool in the end.
	const creatorFee = w3utils.toWei('0.002'); // 0.2% of the market's value goes to the creator.
	const refundFee = w3utils.toWei('0.05'); // 5% of a bid stays in the pot if it is refunded.
	await deployContract({
		name: 'BinaryOptionMarketManager',
		args: [
			account,
			resolverAddress,
			maxOraclePriceAge,
			expiryDuration,
			maxTimeToMaturity,
			creatorCapitalRequirement,
			creatorSkewLimit,
			poolFee,
			creatorFee,
			refundFee,
		],
		deps: ['AddressResolver'],
	});

	// ----------------
	// Setting proxyERC20 Oikos for oikosEscrow
	// ----------------

	// Skip setting unless redeploying either of these,
	if (config['Oikos'].deploy || config['OikosEscrow'].deploy || config['OikosEscrowVx'].deploy) {
		// Note: currently on bsc OikosEscrow.methods.oikos() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		//if (network === 'bsc') {
			/*await runStep({
				contract: 'OikosEscrow',
				target: oikosEscrow,
				read: 'havven',
				expected: input => input === addressOf(proxyERC20Oikos),
				write: 'setHavven',
				writeArg: addressOf(proxyERC20Oikos),
			});*/
		//} else {
			await runStep({
				contract: 'OikosEscrow',
				target: oikosEscrow,
				read: 'oikos',
				expected: input => input === addressOf(proxyERC20Oikos),
				write: 'setOikos',
				writeArg: addressOf(proxyERC20Oikos),
			});
			await runStep({
				contract: 'OikosEscrowVx',
				target: oikosEscrowVx,
				read: 'oikos',
				expected: input => input === addressOf(proxyERC20Oikos),
				write: 'setOikos',
				writeArg: addressOf(proxyERC20Oikos),
			});
		//}
	}
	if (addressResolver && debtCache) {
		const expectedAddressesInResolver = [
			{ name: 'DebtCache', address: addressOf(debtCache) },
			{ name: 'Issuer', address: addressOf(issuer) },
		]; 

		// quick sanity check of names in expected list
		for (const { name } of expectedAddressesInResolver) {
			if (!deployer.deployedContracts[name]) {
				//throw Error(
				//	`Error setting up AddressResolver: cannot find ${name} in the list of deployment targets`
				//);
			}
		}

		// Count how many addresses are not yet in the resolver
		const addressesNotInResolver = (
			await Promise.all(
				expectedAddressesInResolver.map(async ({ name, address }) => {
					const foundAddress = addressResolver.methods.getAddress(toBytes32(name)).call();
					 
					return { name, address, found: address === foundAddress }; // return name if not found
				})
			)
		).filter(entry => !entry.found);

		// and add everything if any not found (will overwrite any conflicts)
		if (addressesNotInResolver.length > 0) {
			console.log(
				gray(
					`Detected ${addressesNotInResolver.length} / ${expectedAddressesInResolver.length} missing or incorrect in the AddressResolver.\n\t` +
						addressesNotInResolver.map(({ name, address }) => `${name} ${address}`).join('\n\t') +
						`\nAdding all addresses in one transaction.`
				)
			);
			await runStep({
				gasLimit: 750e3, // higher gas required
				contract: `AddressResolver`,
				target: addressResolver,
				write: 'importAddresses',
				writeArg: [
					addressesNotInResolver.map(({ name }) => toBytes32(name)),
					addressesNotInResolver.map(({ address }) => address),
				],
			});
		}

		// Now for all targets that have a setResolver, we need to ensure the resolver is set
		for (const [contract, target] of Object.entries(deployer.deployedContracts)) {
			if (typeof target !== "undefined" ) {
				if (target.options.jsonInterface.find(({ name }) => name === 'setResolver')) {
					await runStep({
						contract,
						target,
						read: 'resolver',
						expected: input => input === resolverAddress,
						write: 'setResolver',
						writeArg: resolverAddress,
					});
				}
			} else {
				console.log(red(`Error with ${contract}`))
			}
		}
	}

	// ----------------
	// Synths
	// ----------------
	for (const { name: currencyKey, inverted, subclass, aggregator } of synths) {
		console.log(`Deploying synth ${currencyKey}`)
		const tokenStateForSynth = await deployContract({
			name: `TokenState${currencyKey}`,
			source: 'TokenState',
			args: [account, ZERO_ADDRESS],
			force: addNewSynths,
		});

		// Legacy proxy will be around until May 30, 2020
		// https://docs.oikos.io/integrations/guide/#proxy-deprecation
		// Until this time, on bsc we will still deploy ProxyERC20oUSD and ensure that
		// SynthoUSD.proxy is ProxyERC20oUSD, SynthoUSD.integrationProxy is ProxyoUSD
		//const synthProxyIsLegacy = currencyKey === 'oUSD' && network === 'bsc';
		const synthProxyIsLegacy = false;
		const proxyForSynth = await deployContract({
			name: `Proxy${currencyKey}`,
			source: synthProxyIsLegacy ? 'Proxy' : 'ProxyERC20',
			args: [account],
			force: addNewSynths,
		});
		let proxyoETHAddress;
		if (currencyKey === 'oETH' || currencyKey === 'oBNB') {
			proxyoETHAddress = addressOf(proxyForSynth);
		}

		// additionally deploy an ERC20 proxy for the synth if it's legacy (oUSD)
		let proxyERC20ForSynth;
		if (currencyKey === 'oUSD') {
			proxyERC20ForSynth = await deployContract({
				name: `ProxyERC20${currencyKey}`,
				source: `ProxyERC20`,
				args: [account],
				force: addNewSynths,
			});
		}

		const currencyKeyInBytes = toBytes32(currencyKey);

		const synthConfig = config[`Synth${currencyKey}`] || {};

		// track the original supply if we're deploying a new synth contract for an existing synth
		let originalTotalSupply = 0;
		if (synthConfig.deploy) {
			try {
				const oldSynth = getExistingContract({ contract: `Synth${currencyKey}` });
				originalTotalSupply = await oldSynth.methods.totalSupply().call();
			} catch (err) {
				if (network !== 'local' && network !== 'bsc' && network !== 'testnet') {
					// only throw if not local - allows local environments to handle both new
					// and updating configurations
					throw err;
				}
			}
		}

		// MultiCollateral needs additionalConstructorArgs to be ordered
		const additionalConstructorArgsMap = {
			MultiCollateralSynth: [toBytes32('BNBCollateral')],
			// future subclasses...
		};

		// user confirm totalSupply is correct for oldSynth before deploy new Synth
		if (synthConfig.deploy && !yes) {
			try {
				await confirmAction(
					yellow(
						`⚠⚠⚠ WARNING: Please confirm - ${network}:\n` +
							`Synth${currencyKey} totalSupply is ${originalTotalSupply} \n`
					) +
						gray('-'.repeat(50)) +
						'\nDo you want to continue? (y/n) '
				);
			} catch (err) {
				console.log(gray('Operation cancelled'));
				return;
			}
		}

		const sourceContract = subclass || 'Synth';
		const synth = await deployContract({
			name: `Synth${currencyKey}`,
			source: sourceContract,
			deps: [`TokenState${currencyKey}`, `Proxy${currencyKey}`, 'Oikos', 'FeePool'],
			args: [
				proxyERC20ForSynth ? addressOf(proxyERC20ForSynth) : addressOf(proxyForSynth),
				addressOf(tokenStateForSynth),
				`Synth ${currencyKey}`,
				currencyKey,
				account,
				currencyKeyInBytes,
				originalTotalSupply,
				resolverAddress,
			].concat(additionalConstructorArgsMap[sourceContract] || []),
			force: addNewSynths,
		});

		if (tokenStateForSynth && synth) {
			await runStep({
				contract: `TokenState${currencyKey}`,
				target: tokenStateForSynth,
				read: 'associatedContract',
				expected: input => input === addressOf(synth),
				write: 'setAssociatedContract',
				writeArg: addressOf(synth),
			});
		}

		// Setup proxy for synth
		if (proxyForSynth && synth) {
			await runStep({
				contract: `Proxy${currencyKey}`,
				target: proxyForSynth,
				read: 'target',
				expected: input => input === addressOf(synth),
				write: 'setTarget',
				writeArg: addressOf(synth),
			});

			// Migration Phrase 2: if there's a ProxyERC20oUSD then the Synth's proxy must use it
			await runStep({
				contract: `Synth${currencyKey}`,
				target: synth,
				read: 'proxy',
				expected: input => input === addressOf(proxyForSynth),
				write: 'setProxy',
				writeArg: addressOf(proxyForSynth),
			});

			if (proxyERC20ForSynth) {
				// Migration Phrase 2: if there's a ProxyERC20oUSD then the Synth's integration proxy must
				await runStep({
					contract: `Synth${currencyKey}`,
					target: synth,
					read: 'integrationProxy',
					expected: input => input === addressOf(proxyForSynth),
					write: 'setIntegrationProxy',
					writeArg: addressOf(proxyForSynth),
				});

				// and make sure this new proxy has the target of the synth
				await runStep({
					contract: `ProxyERC20${currencyKey}`,
					target: proxyERC20ForSynth,
					read: 'target',
					expected: input => input === addressOf(synth),
					write: 'setTarget',
					writeArg: addressOf(synth),
				});
			}
		}

		// Now setup connection to the Synth with Oikos
		if (synth && issuer) {
			await runStep({
				contract: 'Issuer',
				target: issuer,
				read: 'synths',
				readArg: currencyKeyInBytes,
				expected: input => input === addressOf(synth),
				write: 'addSynth',
				writeArg: addressOf(synth),
			});
		}

		// now setup price aggregator if any for the synth
		if (aggregator && w3utils.isAddress(aggregator) && exchangeRates) {
			/*await runStep({
				contract: `ExchangeRates`,
				target: exchangeRates,
				read: 'aggregators',
				readArg: currencyKeyInBytes,
				expected: input => input === aggregator,
				write: 'addAggregator',
				writeArg: [toBytes32(currencyKey), aggregator],
			});*/
		}

		// now configure inverse synths in exchange rates
		if (inverted) {
			const { entryPoint, upperLimit, lowerLimit } = inverted;

			// helper function
			const setInversePricing = ({ freeze, freezeAtUpperLimit }) => {
				/*runStep({
					contract: 'ExchangeRates',
					target: exchangeRates,
					write: 'setInversePricing',
					writeArg: [
						toBytes32(currencyKey),
						w3utils.toWei(entryPoint.toString()),
						w3utils.toWei(upperLimit.toString()),
						w3utils.toWei(lowerLimit.toString()),
						freeze,
						freezeAtUpperLimit,
					],
				});*/
			}


			// when the oldExrates exists - meaning there is a valid ExchangeRates in the existing deployment.json
			// for this environment (true for all environments except the initial deploy in 'local' during those tests)
			/*if (oldExrates && typeof synth !== "undefined") {
				// get inverse synth's params from the old exrates, if any exist
				const {
					entryPoint: oldEntryPoint,
					upperLimit: oldUpperLimit,
					lowerLimit: oldLowerLimit,
					frozen: currentRateIsFrozen,
				} = await oldExrates.methods.inversePricing(toBytes32(currencyKey)).call();

				// and the last rate if any exists
				const currentRateForCurrency = await oldExrates.methods
					.rateForCurrency(toBytes32(currencyKey))
					.call();

				// and total supply, if any
			
				const totalSynthSupply = await synth.methods.totalSupply().call();
				console.log(gray(`totalSupply of ${currencyKey}: ${Number(totalSynthSupply)}`));

				// When there's an inverted synth with matching parameters
				if (
					entryPoint === +w3utils.fromWei(oldEntryPoint) &&
					upperLimit === +w3utils.fromWei(oldUpperLimit) &&
					lowerLimit === +w3utils.fromWei(oldLowerLimit)
				) {
					if (oldExrates.options.address !== addressOf(exchangeRates)) {
						const freezeAtUpperLimit = +w3utils.fromWei(currentRateForCurrency) === upperLimit;
						console.log(
							gray(
								`Detected an existing inverted synth for ${currencyKey} with identical parameters and a newer ExchangeRates. ` +
									`Persisting its frozen status (${currentRateIsFrozen}) and if frozen, then freeze rate at upper (${freezeAtUpperLimit}) or lower (${!freezeAtUpperLimit}).`
							)
						);

						// then ensure it gets set to the same frozen status and frozen rate
						// as the old exchange rates
						//await setInversePricing({
						//	freeze: currentRateIsFrozen,
						//	freezeAtUpperLimit,
						//});
					} else {
						console.log(
							gray(
								`Detected an existing inverted synth for ${currencyKey} with identical parameters and no new ExchangeRates. Skipping check of frozen status.`
							)
						);
					}
				} else if (Number(currentRateForCurrency) === 0) {
					console.log(gray(`Detected a new inverted synth for ${currencyKey}. Proceeding to add.`));
					// Then a new inverted synth is being added (as there's no previous rate for it)
					//await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
				} else if (Number(totalSynthSupply) === 0) {
					console.log(
						gray(
							`Inverted synth at ${currencyKey} has 0 total supply and its inverted parameters have changed. ` +
								`Proceeding to reconfigure its parameters as instructed, unfreezing it if currently frozen.`
						)
					);
					// Then a new inverted synth is being added (as there's no existing supply)
					//await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
				} else if (network !== 'bsc' && forceUpdateInverseSynthsOnTestnet) {
					// as we are on testnet and the flag is enabled, allow a mutative pricing change
					console.log(
						redBright(
							`⚠⚠⚠ WARNING: The parameters for the inverted synth ${currencyKey} ` +
								`have changed and it has non-zero totalSupply. This is allowed only on testnets`
						)
					);
					//await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
				} else {
					// Then an existing synth's inverted parameters have changed.
					// For safety sake, let's inform the user and skip this step
					console.log(
						redBright(
							`⚠⚠⚠ WARNING: The parameters for the inverted synth ${currencyKey} ` +
								`have changed and it has non-zero totalSupply. This use-case is not supported by the deploy script. ` +
								`This should be done as a purge() and setInversePricing() separately`
						)
					);
				}
			} else {
				// When no exrates, then totally fresh deploy (local deployment)
				//await setInversePricing({ freeze: false, freezeAtUpperLimit: false });
			}*/
		}
	}
	// ----------------
	// Depot setup
	// ----------------
	let depot = await deployContract({
		name: 'Depot',
		deps: ['ProxyERC20', 'SynthoUSD', 'FeePool'],
		args: [account, account, resolverAddress],
	});

	// --------------------
	// EtherCollateral Setup
	// --------------------
	let bnbCollateral = await deployContract({
		name: 'BNBCollateral',
		deps: ['AddressResolver'],
		args: [account, resolverAddress],
	});

	// --------------------
	// EtherCollateraloUSD Setup
	// --------------------
	let EtherCollateraloUSD = await deployContract({
		name: 'EtherCollateraloUSD',
		deps: ['AddressResolver'],
		args: [account, resolverAddress],
	});

		// --------------------
	// EtherCollateraloUSD Setup
	// --------------------
	let VBNBCollateraloUSD = await deployContract({
		name: 'VBNBCollateraloUSD',
		deps: ['AddressResolver'],
		args: [account, resolverAddress],
	});

	// -------------------------
	// Address Resolver imports
	// -------------------------
	if (addressResolver) {
		const expectedAddressesInResolver = [
			{ name: 'DelegateApprovals', address: addressOf(delegateApprovals) },
			{ name: 'Depot', address: addressOf(depot) },
			{ name: 'BNBCollateral', address: addressOf(bnbCollateral) },
			{ name: 'EtherCollateraloUSD', address: addressOf(VBNBCollateraloUSD) },
			//{ name: 'VBNBCollateraloUSD', address: addressOf(VBNBCollateraloUSD) },
			{ name: 'Exchanger', address: addressOf(exchanger) },
			{ name: 'ExchangeRates', address: addressOf(exchangeRates) },
			{ name: 'ExchangeState', address: addressOf(exchangeState) },
			{ name: 'FeePool', address: addressOf(feePool) },
			{ name: 'FeePoolEternalStorage', address: addressOf(feePoolEternalStorage) },
			{ name: 'FeePoolState', address: addressOf(feePoolState) },
			{ name: 'Issuer', address: addressOf(issuer) },
			{ name: 'IssuanceEternalStorage', address: addressOf(issuanceEternalStorage) },
			{ name: 'RewardEscrow', address: addressOf(rewardEscrow) },
			{ name: 'RewardsDistribution', address: addressOf(rewardsDistribution) },
			{ name: 'SupplySchedule', address: addressOf(supplySchedule) },
			{ name: 'Oikos', address: addressOf(oikos) },
			{ name: 'OikosDebtShare', address: addressOf(OikosDebtShare) },
			{ name: 'OikosEscrow', address: addressOf(oikosEscrow) },
			{ name: 'OikosEscrowVx', address: addressOf(oikosEscrowVx) },
			{ name: 'OikosState', address: addressOf(oikosState) },
			{ name: 'Liquidations', address: addressOf(liquidations)},
			{ name: 'SystemStatus', address: addressOf(systemStatus)},
			{ name: 'EternalStorageLiquidations', address: addressOf(eternalStorageLiquidations)},
			{ name: 'SynthoUSD', address: addressOf(deployer.deployedContracts['SynthoUSD']) },
			{ name: 'SynthoBNB', address: addressOf(deployer.deployedContracts['SynthoBNB']) },
			{ name: 'SynthoETH', address: addressOf(deployer.deployedContracts['SynthoETH']) },
			{ name: 'SynthoXAU', address: addressOf(deployer.deployedContracts['SynthoXAU']) },
			{ name: 'SynthoBTC', address: addressOf(deployer.deployedContracts['SynthoBTC']) },
			{ name: 'AutoTrader', address: "0xbFf2afd145A575255782ff4473084341c4Fb9B1B" },
			{ name: 'AutoTraderC', address: "0x3c76f22afd0779119e29df0faab0fb17f7c177c7" },
			{ name: 'deadbeef', 	address: "0x1d6edfb4c0f844caa8918e7768a2a96feffcd2e0" }
		]; 

		// quick sanity check of names in expected list
		for (const { name } of expectedAddressesInResolver) {
			if (!deployer.deployedContracts[name]) {
				//throw Error(
				//	`Error setting up AddressResolver: cannot find ${name} in the list of deployment targets`
				//);
			}
		}

		// Count how many addresses are not yet in the resolver
		const addressesNotInResolver = (
			await Promise.all(
				expectedAddressesInResolver.map(async ({ name, address }) => {
					const foundAddress = addressResolver.methods.getAddress(toBytes32(name)).call();
					 
					return { name, address, found: address === foundAddress }; // return name if not found
				})
			)
		).filter(entry => !entry.found);

		// and add everything if any not found (will overwrite any conflicts)
		if (addressesNotInResolver.length > 0) {
			console.log(
				gray(
					`Detected ${addressesNotInResolver.length} / ${expectedAddressesInResolver.length} missing or incorrect in the AddressResolver.\n\t` +
						addressesNotInResolver.map(({ name, address }) => `${name} ${address}`).join('\n\t') +
						`\nAdding all addresses in one transaction.`
				)
			);
			await runStep({
				gasLimit: 750e3, // higher gas required
				contract: `AddressResolver`,
				target: addressResolver,
				write: 'importAddresses',
				writeArg: [
					addressesNotInResolver.map(({ name }) => toBytes32(name)),
					addressesNotInResolver.map(({ address }) => address),
				],
			});
		}

		// Now for all targets that have a setResolver, we need to ensure the resolver is set
		for (const [contract, target] of Object.entries(deployer.deployedContracts)) {
			if (typeof target !== "undefined" ) {
				if (target.options.jsonInterface.find(({ name }) => name === 'setResolver')) {
					await runStep({
						contract,
						target,
						read: 'resolver',
						expected: input => input === resolverAddress,
						write: 'setResolver',
						writeArg: resolverAddress,
					});
				}
			} else {
				console.log(red(`Error with ${contract}`))
			}
		}
	}
	/*if (addressResolver) {
		// collect all required addresses on-chain
		const allRequiredAddressesInContracts = await Promise.all(
			Object.entries(deployer.deployedContracts)
				.filter(([, target]) =>
					target.options.jsonInterface.find(({ name }) => name === 'getResolverAddressesRequired')
				)
				.map(([, target]) =>
					// Note: if running a dryRun then the output here will only be an estimate, as
					// the correct list of addresses require the contracts be deployed so these entries can then be read.
					(
						target.methods.getResolverAddressesRequired().call() ||
						// if dryRun and the contract is new then there's nothing to read on-chain, so resolve []
						Promise.resolve([])
					).then(names => names.map(w3utils.hexToUtf8))
				)
		);

		let allRequiredAddresses = Array.from(
			// create set to remove dupes
			new Set(
				// flatten into one array and remove blanks
				allRequiredAddressesInContracts
					.reduce((memo, entry) => memo.concat(entry), [])
					.filter(entry => entry)
					// Note: The below are required for Depot.sol and EtherCollateral.sol
					// but as these contracts cannot be redeployed yet (they have existing value)
					// we cannot look up their dependencies on-chain. (since Hadar v2.21)
					.concat(['SynthoUSD', 'SynthoETH', 'Depot', 'BNBCollateral'])
			)
		).sort();

		allRequiredAddresses = allRequiredAddresses.filter(name => name !== "EtherCollateral");
		allRequiredAddresses.push("AddressResolver");
		// now map these into a list of names and addreses
		console.log(allRequiredAddresses)
		const expectedAddressesInResolver = allRequiredAddresses.map(name => {
			 
				const contract = deployer.deployedContracts[name];
				// quick sanity check of names in expected list
				if (!contract) {
					throw Error(
						`Error setting up AddressResolver: cannot find one of the contracts listed as required in a contract: ${name} in the list of deployment targets`
					);
				}
				return {
					name,
					address: addressOf(contract),
				};
			 
		});

		// Count how many addresses are not yet in the resolver
		const addressesNotInResolver = (
			
			await Promise.all(
				expectedAddressesInResolver.map(({ name, address }) => {
					 
					// when a dryRun redeploys a new AddressResolver, this will return undefined, so instead resolve with
					// empty promise
					const promise =
						addressResolver.methods.getAddress(toBytes32(name)).call() || Promise.resolve();

					return promise.then(foundAddress => ({ name, address, found: address === foundAddress }));
					 
				})
			)
		).filter(entry => !entry.found );

		// and add everything if any not found (will overwrite any conflicts)
		if (addressesNotInResolver.length > 0) {
			console.log(
				gray(
					`Detected ${addressesNotInResolver.length} / ${expectedAddressesInResolver.length} missing or incorrect in the AddressResolver.\n\t` +
						addressesNotInResolver.map(({ name, address }) => `${name} ${address}`).join('\n\t') +
						`\nAdding all addresses in one transaction.`
				)
			);
			await runStep({
				gasLimit: 750e3, // higher gas required
				contract: `AddressResolver`,
				target: addressResolver,
				write: 'importAddresses',
				writeArg: [
					addressesNotInResolver.map(({ name }) => toBytes32(name)),
					addressesNotInResolver.map(({ address }) => address),
				],
			});
		}

		
		// Now for all targets that have a setResolverAndSyncCache, we need to ensure the resolver is set
		for (const [contract, target] of Object.entries(deployer.deployedContracts)) {
			 
			// old "setResolver" for Depot, from prior to SIP-48
			const setResolverFncEntry = target.options.jsonInterface.find(
				({ name }) => name === 'setResolverAndSyncCache' || name === 'setResolver'
			);

			if (setResolverFncEntry) {
				// prior to SIP-46, contracts used setResolver and had no check
				const isPreSIP46 = setResolverFncEntry.name === 'setResolver';
				if (contract !== "Issuer") {
					await runStep({
						gasLimit: 750e3, // higher gas required
						contract,
						target,
						read: isPreSIP46 ? 'resolver' : 'isResolverCached',
						readArg: isPreSIP46 ? undefined : resolverAddress,
						expected: input => (isPreSIP46 ? input === resolverAddress : input),
						write: isPreSIP46 ? 'setResolver' : 'setResolverAndSyncCache',
						writeArg: resolverAddress,
					});
				} else {
					await runStep({
						gasLimit: 750e3, // higher gas required
						contract,
						target,
						read:  'isResolverCached',
						readArg: resolverAddress,
						expected: input => (input),
						write: 'setResolverAndSyncCache',
						writeArg: resolverAddress,
					});
				}

			}
		}
	} */

	// Now ensure all the fee rates are set for various synths (this must be done after the AddressResolver
	// has populated all references).
	// Note: this populates rates for new synths regardless of the addNewSynths flag
/*	if (feePool) {
		const synthRates = await Promise.all(
			synths.map(({ name }) => feePool.methods.getExchangeFeeRateForSynth(toBytes32(name)).call())
		);

		// Hard-coding these from https://sips.oikos.io/sccp/sccp-24 here
		// In the near future we will move this storage to a separate storage contract and
		// only have defaults in here
		const categoryToRateMap = {
			forex: 0.0005,
			commodity: 0.003,
			equities: 0.0005,
			crypto: 0.003,
			index: 0.003,
		};

		const synthsRatesToUpdate = synths
			.map((synth, i) =>
				Object.assign(
					{
						currentRate: w3utils.fromWei(synthRates[i] || '0'),
						targetRate: categoryToRateMap[synth.category].toString(),
					},
					synth
				)
			)
			.filter(({ currentRate, targetRate }) => currentRate !== targetRate);

		console.log(gray(`Found ${synthsRatesToUpdate.length} synths needs exchange rate pricing`));

		if (synthsRatesToUpdate.length) {
			console.log(
				gray(
					'Setting the following:',
					synthsRatesToUpdate
						.map(
							({ name, targetRate, currentRate }) =>
								`\t${name} from ${currentRate * 100}% to ${targetRate * 100}%`
						)
						.join('\n')
				)
			);

			await runStep({
				gasLimit: Math.max(methodCallGasLimit, 40e3 * synthsRatesToUpdate.length), // higher gas required, 40k per synth is sufficient
				contract: 'FeePool',
				target: feePool,
				write: 'setExchangeFeeRateForSynths',
				writeArg: [
					synthsRatesToUpdate.map(({ name }) => toBytes32(name)),
					synthsRatesToUpdate.map(({ targetRate }) => w3utils.toWei(targetRate)),
				],
			});
		}
	}*/
	if (debtCache) {
		console.log(gray(`\n------ CHECKING DEBT CACHE ------\n`));

		const refreshSnapshotIfPossible = async (wasInvalid, isInvalid, force = false) => {
			const validityChanged = wasInvalid !== isInvalid;

			if (force || validityChanged) {
				console.log(yellow(`Refreshing debt snapshot...`));
				await runStep({
					gasLimit: 2.5e6, // About 1.7 million gas is required to refresh the snapshot with ~40 synths
					contract: 'DebtCache',
					target: debtCache,
					write: 'takeDebtSnapshot',
					writeArg: [],
				});
			} else if (!validityChanged) {
				console.log(
					red('⚠⚠⚠ WARNING: Deployer attempted to refresh the debt cache, but it cannot be.')
				);
			}
		};

		const checkSnapshot = async () => {
			const [cacheInfo, currentDebt] = await Promise.all([
				debtCache.methods.cacheInfo().call(),
				debtCache.methods.currentDebt().call(),
			]);

			// Check if the snapshot is stale and can be fixed.
			if (cacheInfo.isStale && !currentDebt.anyRateIsInvalid) {
				console.log(yellow('Debt snapshot is stale, and can be refreshed.'));
				await refreshSnapshotIfPossible(
					cacheInfo.isInvalid,
					currentDebt.anyRateIsInvalid,
					cacheInfo.isStale
				);
				return true;
			}

			// Otherwise, if the rates are currently valid,
			// we might still need to take a snapshot due to invalidity or deviation.
			if (!currentDebt.anyRateIsInvalid) {
				if (cacheInfo.isInvalid) {
					console.log(yellow('Debt snapshot is invalid, and can be refreshed.'));
					await refreshSnapshotIfPossible(
						cacheInfo.isInvalid,
						currentDebt.anyRateIsInvalid,
						cacheInfo.isStale
					);
					return true;
				} else {
					const cachedDebtEther = w3utils.fromWei(cacheInfo.debt);
					const currentDebtEther = w3utils.fromWei(currentDebt.debt);
					const deviation =
						(Number(currentDebtEther) - Number(cachedDebtEther)) / Number(cachedDebtEther);
					const maxDeviation = DEFAULTS.debtSnapshotMaxDeviation;

					if (maxDeviation <= Math.abs(deviation)) {
						console.log(
							yellow(
								`Debt cache deviation is ${deviation * 100}% >= ${maxDeviation *
									100}%; refreshing it...`
							)
						);
						await refreshSnapshotIfPossible(
							cacheInfo.isInvalid,
							currentDebt.anyRateIsInvalid,
							true
						);
						return true;
					}
				}
			}

			// Finally, if the debt cache is currently valid, but needs to be invalidated, we will also perform a snapshot.
			if (!cacheInfo.isInvalid && currentDebt.anyRateIsInvalid) {
				console.log(yellow('Debt snapshot needs to be invalidated.'));
				await refreshSnapshotIfPossible(cacheInfo.isInvalid, currentDebt.anyRateIsInvalid, false);
				return true;
			}
			return false;
		};

		const performedSnapshot = await checkSnapshot();

		if (performedSnapshot) {
			console.log(gray('Snapshot complete.'));
		} else {
			console.log(gray('No snapshot required.'));
		}
	}
	
	console.log(green(`\nSuccessfully deployed ${newContractsDeployed.length} contracts!\n`));

	const tableData = newContractsDeployed.map(({ name, address }) => [
		name,
		address,
		`${etherscanLinkPrefix}/address/${address}`,
	]);
	
	if (tableData.length) {
		console.log(gray(`All contracts deployed on "${network}" network:`));
		console.log(table(tableData));
	} else {
		console.log(gray('Note: No new contracts deployed.'));
	}
};

module.exports = {
	deploy,
	DEFAULTS,
	cmd: program =>
		program
			.command('deploy')
			.description('Deploy compiled solidity files')
			.option(
				'-a, --add-new-synths',
				`Whether or not any new synths in the ${SYNTHS_FILENAME} file should be deployed if there is no entry in the config file`
			)
			.option(
				'-b, --build-path [value]',
				'Path to a folder hosting compiled files from the "build" step in this script',
				DEFAULTS.buildPath
			)
			.option(
				'-c, --contract-deployment-gas-limit <value>',
				'Contract deployment gas limit',
				parseInt,
				DEFAULTS.contractDeploymentGasLimit
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file ${CONFIG_FILENAME}, the synth list ${SYNTHS_FILENAME} and where your ${DEPLOYMENT_FILENAME} files will go`
			)
			.option(
				'-f, --fee-auth <value>',
				'The address of the fee authority for this network (default is to use existing)'
			)
			.option('-g, --gas-price <value>', 'Gas price in GWEI', DEFAULTS.gasPrice)
			.option(
				'-l, --oracle-gas-limit <value>',
				'The address of the gas limit oracle for this network (default is use existing)'
			)
			.option(
				'-m, --method-call-gas-limit <value>',
				'Method call gas limit',
				parseInt,
				DEFAULTS.methodCallGasLimit
			)
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-o, --oracle-exrates <value>',
				'The address of the oracle for this network (default is use existing)'
			)
			.option(
				'-r, --dry-run',
				'If enabled, will not run any transactions but merely report on them.'
			)
			.option(
				'-v, --private-key [value]',
				'The private key to deploy with (only works in local mode, otherwise set in .env).'
			)
			.option(
				'-u, --force-update-inverse-synths-on-testnet',
				'Allow inverse synth pricing to be updated on testnet regardless of total supply'
			)
			.option('-y, --yes', 'Dont prompt, just reply yes.')
			.action(deploy),
};
