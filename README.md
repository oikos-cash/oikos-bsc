# Oikos

[![Twitter Follow](https://img.shields.io/twitter/follow/oikos_io.svg?label=oikos_io&style=social)](https://twitter.com/oikos_cash)

Oikos is a crypto-backed synthetic asset platform.

It is a multitoken system, powered by OKS, the Oikos Network Token. OKS holders can stake OKS to issue Synths, on-chain synthetic assets via the [Minter Dapp](https://minter.oikos.cash) The network currently supports an ever growing [list of synthetic assets](https://oikos.cash/tokens/). Please see the [list of the deployed contracts on MAIN and TESTNETS](https://docs.oikos.cash/addresses/)
Synths can be traded using (https://oikos.exchange)

Oikos uses a proxy system so that upgrades will not be disruptive to the functionality of the contract. This smooths user interaction, since new functionality will become available without any interruption in their experience. It is also transparent to the community at large, since each upgrade is accompanied by events announcing those upgrades. New releases are managed via the [Oikos Improvement Proposal (SIP)](https://sips.oikos.cash/all-sip) system similar to the [EF's EIPs](https://eips.ethereum.org/all)

Prices are commited on chain by a trusted oracle.

Please note that this repository is under development.

The code here will be under continual audit and improvement as the project progresses.

## DApps

- https://minter.oikos.cash
- https://oikos.exchange
- https://stats.oikos.cash

## Branching

A note on the branches used in this repo.

- `master` represents the contracts live on `mainnet` and all testnets.

When a new version of the contracts makes its way through all testnets, it eventually becomes promoted in `master`, with [semver](https://semver.org/) reflecting contract changes in the `major` or `minor` portion of the version (depending on backwards compatibility). `patch` changes are simply for changes to the JavaScript interface.

## Usage and requirements

### As an npm module

```javascript
const oks = require('oikos-bsc');

// retrieve an object detailing the contract deployed to the given network.
oks.getTarget({ network: 'bsc', contract: 'ProxyOikos' });
/*
		ProxyOikos: {
			name: "ProxyOikos",
			address: "0xD086F0673cD4b27dFA958bbbBB6d65a30a37035B",
			source: "Proxy",
			link: "https://bsc.etherscan.io/address/0xD086F0673cD4b27dFA958bbbBB6d65a30a37035B",
			timestamp: "2021-03-14T18:38:41.154Z",
			txn: "",
			network: "bsc"
		}
*/

// retrieve an object detailing the contract ABI and bytecode
oks.getSource({ network: 'bsc', contract: 'Proxy' });
/*
{
  bytecode: '0..0',
  abi: [ ... ]
}
*/

// retrieve the array of synths used
oks.getSynths({ network: 'bsc' }).map(({ name }) => name);
// ['sUSD', 'sEUR', ...]
```

### For tests (in JavaScript)

Install the dependencies for the project using npm

```
$ npm i
```

To run the tests:

```
$ npm test
```

## System Summary

Traditionally gold was used as a reserve store of value by various governments around the world to prove that there was value to back their currency. The Oikos system replicates this setup, but completely on-chain, and with multiple flavours of stablecoin (Synths), and a store of value backing them up (OKS - Oikos Network Token).

As users exchange synths via `Exchanger.exchange()` or on [oikos.exchange](https://oikos.exchange), small fees are remitted, which get sent to OKS holders that enable the economy to exist.

Users are able to withdraw their fees sUSD. Users are entitled to fees once they've issued synths (to help create the economy generating the fees) and waited for a complete fee period to elapse (currently 7 days). Issuers are incentivised to maintain the ratio of collateral (OKS) to Synths such that the Synths in circulation are generally only worth 20% of the value of the Oikos Network Tokens backing them up via a penalty for being over 20% collateralised. This allows pretty severe price shocks to OKS without threatening the value of the Synths.

Also it's worth noting that there's a decimal library being used for "floating point" math with 10^18 as the base. Also many of the contracts are provided behind a proxy contract for easy upgradability.

---

## Documentation

For the latest system documentaion see
- http://docs.oikos.cash