'use strict';

const fs = require('fs');
const path = require('path');
const w3utils = require('web3-utils');

const constants = {
	BUILD_FOLDER: 'build',
	CONTRACTS_FOLDER: 'contracts',
	COMPILED_FOLDER: 'compiled',
	FLATTENED_FOLDER: 'flattened',
	AST_FOLDER: 'ast',

	CONFIG_FILENAME: 'config.json',
	SYNTHS_FILENAME: 'synths.json',
	OWNER_ACTIONS_FILENAME: 'owner-actions.json',
	DEPLOYMENT_FILENAME: 'deployment.json',
	VERSIONS_FILENAME: 'versions.json',

	AST_FILENAME: 'asts.json',

	ZERO_ADDRESS: '0x' + '0'.repeat(40),

	inflationStartTimestampInSecs: 1551830400, // 2019-03-06T00:00:00Z
};

/**
 * Converts a string into a hex representation of bytes32, with right padding
 */
const toBytes32 = key => w3utils.rightPad(w3utils.asciiToHex(key), 64);

const loadDeploymentFile = ({ network }) => {
	const pathToDeployment = getPathToNetwork({ network, file: constants.DEPLOYMENT_FILENAME });
	if (!fs.existsSync(pathToDeployment)) {
		throw Error(`Cannot find deployment for network: ${network}.`);
	}
	return JSON.parse(fs.readFileSync(pathToDeployment));
};

/**
 * Retrieve the list of targets for the network - returning the name, address, source file and link to etherscan
 */
const getTarget = ({ network = 'bsc', contract } = {}) => {
	const deployment = loadDeploymentFile({ network });
	if (contract) return deployment.targets[contract];
	else return deployment.targets;
};

/**
 * Retrieve the list of solidity sources for the network - returning the abi and bytecode
 */
const getSource = ({ network = 'bsc', contract } = {}) => {
	const deployment = loadDeploymentFile({ network });
	if (contract) return deployment.sources[contract];
	else return deployment.sources;
};

/**
 * Retrieve the ASTs for the source contracts
 */
const getAST = ({ source, match = /^contracts\// } = {}) => {
	const fullAST = require(path.resolve(
		__dirname,
		constants.BUILD_FOLDER,
		constants.AST_FOLDER,
		constants.AST_FILENAME
	));

	// remove anything not matching the pattern
	const ast = Object.entries(fullAST)
		.filter(([astEntryKey]) => match.test(astEntryKey))
		.reduce((memo, [key, val]) => {
			memo[key] = val;
			return memo;
		}, {});

	if (source && source in ast) {
		return ast[source];
	} else if (source) {
		// try to find the source without a path
		const [key, entry] =
			Object.entries(ast).find(([astEntryKey]) => astEntryKey.includes('/' + source)) || [];
		if (!key || !entry) {
			throw Error(`Cannot find AST entry for source: ${source}`);
		}
		return { [key]: entry };
	} else {
		return ast;
	}
};

/**
 * Retrieve ths list of synths for the network - returning their names, assets underlying, category, sign, description, and
 * optional index and inverse properties
 */
const getSynths = ({ network = 'bsc' } = {}) => {
	const pathToSynthList = getPathToNetwork({ network, file: constants.SYNTHS_FILENAME });
	console.log({pathToSynthList});

	if (!fs.existsSync(pathToSynthList)) {
		throw Error(`Cannot find synth list.`);
	}
	const synths = JSON.parse(fs.readFileSync(pathToSynthList));

	// copy all necessary index parameters from the longs to the corresponding shorts
	return synths.map(synth => {
		if (typeof synth.index === 'string') {
			const { index } = synths.find(({ name }) => name === synth.index) || {};
			if (!index) {
				throw Error(
					`While processing ${synth.name}, it's index mapping "${synth.index}" cannot be found - this is an error in the deployment config and should be fixed`
				);
			}
			return Object.assign({}, synth, { index });
		} else {
			return synth;
		}
	});
};

const getPathToNetwork = ({ network = 'bsc', file = '' } = {}) =>
	path.join(__dirname, 'publish', 'deployed', network, file);

/**
 * Retrieve the list of system user addresses
 */
const getUsers = ({ network = 'bsc', user } = {}) => {
	const testnetOwner = '0xB64fF7a4a33Acdf48d97dab0D764afD0F6176882';
	const base = {
		owner: testnetOwner,
		deployer: testnetOwner,
		marketClosure: testnetOwner,
		oracle: '0xac1e8B385230970319906C03A1d8567e3996d1d5',
		fee: '0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF',
		zero: '0x' + '0'.repeat(40),
	};

	const map = {
		bsc: Object.assign({}, base, {
			owner: '0xEb3107117FEAd7de89Cd14D463D340A2E6917769',
			deployer: '0xDe910777C787903F78C89e7a0bf7F4C435cBB1Fe',
			marketClosure: '0xC105Ea57Eb434Fbe44690d7Dec2702e4a2FBFCf7',
			oracle: '0xaC1ED4Fabbd5204E02950D68b6FC8c446AC95362',
		}),
		testnet: Object.assign({}, base),
		rinkeby: Object.assign({}, base),
		ropsten: Object.assign({}, base),
	};

	const users = Object.entries(map[network]).map(([key, value]) => ({ name: key, address: value }));

	return user ? users.find(({ name }) => name === user) : users;
};

/**
 * Retrieve the list of tokens used in the Oikos protocol
 */
 const getTokens = ({ network = 'bsc', path, fs, useOvm = false } = {}) => {
	const synths = getSynths({ network, useOvm, path, fs });
	const targets = getTarget({ network, useOvm, path, fs });
	const feeds = []; // getFeeds({ network, useOvm, path, fs });
	
	return [
		Object.assign(
			{
				symbol: 'OKS',
				asset: 'OKS',
				name: 'Oikos',
				address: targets.ProxyOikos.address,
				decimals: 18,
			},
			{} //feeds['OKS'].feed ? { feed: feeds['OKS'].feed } : {}
		),
	].concat(
		synths
			.filter(({ category }) => category !== 'internal')
			.map(synth => ({
				symbol: synth.name,
				asset: synth.asset,
				name: synth.description,
				address: (targets[`Proxy${synth.name}`] || {}).address,
				index: synth.index,
				decimals: 18,
				feed: synth.feed,
			}))
			.sort((a, b) => (a.symbol > b.symbol ? 1 : -1))
	);
};

const getVersions = ({ network = 'bsc', byContract = false } = {}) => {
	const pathToVersions = getPathToNetwork({ network, file: constants.VERSIONS_FILENAME });

	if (!fs.existsSync(pathToVersions)) {
		console.log(`Path is ${pathToVersions}`);
		throw Error(`Cannot find versions for network ${network}`);
	}
	const versions = JSON.parse(fs.readFileSync(pathToVersions));
	console.log(versions)
	if (byContract) {
		// compile from the contract perspectives
		return Object.values(versions).reduce((memo, entry) => {
			for (const [contract, contractEntry] of Object.entries(entry.contracts)) {
				memo[contract] = memo[contract] || [];
				memo[contract].push(contractEntry);
			}
			return memo;
		}, {});
	}
	return versions;
};

const getSuspensionReasons = ({ code = undefined } = {}) => {
	const suspensionReasonMap = {
		1: 'System Upgrade',
		2: 'Market Closure',
		3: 'Circuit breaker',
		99: 'Emergency',
	};

	return code ? suspensionReasonMap[code] : suspensionReasonMap;
};

module.exports = {
	getAST,
	getPathToNetwork,
	getSource,
	getSuspensionReasons,
	getSynths,
	getTarget,
	getTokens,
	getUsers,
	getVersions,
	networks: ['testnet', 'bsc', 'local'],
	toBytes32,
	constants,
};
