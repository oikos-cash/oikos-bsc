require('.'); // import common test scaffolding

const ExchangeRates = artifacts.require('ExchangeRates');
const MockAggregator = artifacts.require('MockAggregator');

const {
	currentTime,
	fastForward,
	toUnit,
	bytesToString,
	ZERO_ADDRESS,
} = require('../utils/testUtils');

const { onlyGivenAddressCanInvoke } = require('../utils/setupUtils');

const { toBytes32 } = require('../../.');

const { toBN } = require('web3-utils');
// Helper functions

const getRandomCurrencyKey = () =>
	Math.random()
		.toString(36)
		.substring(2, 6)
		.toUpperCase();

const createRandomKeysAndRates = quantity => {
	const uniqueCurrencyKeys = {};
	for (let i = 0; i < quantity; i++) {
		const rate = Math.random() * 100;
		const key = toBytes32(getRandomCurrencyKey());
		uniqueCurrencyKeys[key] = web3.utils.toWei(rate.toFixed(18), 'ether');
	}

	const rates = [];
	const currencyKeys = [];
	Object.entries(uniqueCurrencyKeys).forEach(([key, rate]) => {
		currencyKeys.push(key);
		rates.push(rate);
	});

	return { currencyKeys, rates };
};

const convertToAggregatorPrice = val => web3.utils.toBN(Math.round(val * 1e8));

contract('Exchange Rates', async accounts => {
	const [deployerAccount, owner, oracle, accountOne, accountTwo] = accounts;
	const [SNX, sJPY, sXTZ, oBNB, oUSD, sEUR, sAUD] = [
		'SNX',
		'sJPY',
		'sXTZ',
		'oBNB',
		'oUSD',
		'sEUR',
		'sAUD',
	].map(toBytes32);
	let instance;
	let timeSent;
	let aggregatorJPY;
	let aggregatorXTZ;
	beforeEach(async () => {
		instance = await ExchangeRates.deployed();
		timeSent = await currentTime();
		aggregatorJPY = await MockAggregator.new({ from: owner });
		aggregatorXTZ = await MockAggregator.new({ from: owner });
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const creationTime = await currentTime();
			const instance = await ExchangeRates.new(
				owner,
				oracle,
				[SNX],
				[web3.utils.toWei('0.2', 'ether')],
				{
					from: deployerAccount,
				}
			);

			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.selfDestructBeneficiary(), owner);
			assert.equal(await instance.oracle(), oracle);

			assert.etherEqual(await instance.rateForCurrency(oUSD), '1');
			assert.etherEqual(await instance.rateForCurrency(SNX), '0.2');

			// Ensure that when the rate isn't found, 0 is returned as the exchange rate.
			assert.etherEqual(await instance.rateForCurrency(toBytes32('OTHER')), '0');

			const lastUpdatedTimeSUSD = await instance.lastRateUpdateTimes.call(oUSD);
			assert.isAtLeast(lastUpdatedTimeSUSD.toNumber(), creationTime);

			const lastUpdatedTimeOTHER = await instance.lastRateUpdateTimes.call(toBytes32('OTHER'));
			assert.equal(lastUpdatedTimeOTHER.toNumber(), 0);

			const lastUpdatedTimeSNX = await instance.lastRateUpdateTimes.call(SNX);
			assert.isAtLeast(lastUpdatedTimeSNX.toNumber(), creationTime);

			const sUSDRate = await instance.rateForCurrency(oUSD);
			assert.bnEqual(sUSDRate, toUnit('1'));
		});

		it('two different currencies in same array should mean that the second one overrides', async () => {
			const creationTime = await currentTime();
			const firstAmount = '4.33';
			const secondAmount = firstAmount + 10;
			const instance = await ExchangeRates.new(
				owner,
				oracle,
				[toBytes32('CARTER'), toBytes32('CARTOON')],
				[web3.utils.toWei(firstAmount, 'ether'), web3.utils.toWei(secondAmount, 'ether')],
				{
					from: deployerAccount,
				}
			);

			assert.etherEqual(await instance.rateForCurrency(toBytes32('CARTER')), firstAmount);
			assert.etherEqual(await instance.rateForCurrency(toBytes32('CARTOON')), secondAmount);

			const lastUpdatedTime = await instance.lastRateUpdateTimes.call(toBytes32('CARTER'));
			assert.isAtLeast(lastUpdatedTime.toNumber(), creationTime);
		});

		it('should revert when number of currency keys > new rates length on create', async () => {
			await assert.revert(
				ExchangeRates.new(
					owner,
					oracle,
					[SNX, toBytes32('GOLD')],
					[web3.utils.toWei('0.2', 'ether')],
					{
						from: deployerAccount,
					}
				)
			);
		});

		it('should limit to 32 bytes if currency key > 32 bytes on create', async () => {
			const creationTime = await currentTime();
			const amount = '4.33';
			const instance = await ExchangeRates.new(
				owner,
				oracle,
				[toBytes32('ABCDEFGHIJKLMNOPQRSTUVXYZ1234567')],
				[web3.utils.toWei(amount, 'ether')],
				{
					from: deployerAccount,
				}
			);

			assert.etherEqual(
				await instance.rateForCurrency(toBytes32('ABCDEFGHIJKLMNOPQRSTUVXYZ1234567')),
				amount
			);
			assert.etherNotEqual(
				await instance.rateForCurrency(toBytes32('ABCDEFGHIJKLMNOPQRSTUVXYZ123456')),
				amount
			);

			const lastUpdatedTime = await instance.lastRateUpdateTimes.call(
				toBytes32('ABCDEFGHIJKLMNOPQRSTUVXYZ1234567')
			);
			assert.isAtLeast(lastUpdatedTime.toNumber(), creationTime);
		});

		it("shouldn't be able to set exchange rate to 0 on create", async () => {
			await assert.revert(
				ExchangeRates.new(owner, oracle, [SNX], [web3.utils.toWei('0', 'ether')], {
					from: deployerAccount,
				})
			);
		});

		it('should be able to handle lots of currencies on creation', async () => {
			const creationTime = await currentTime();
			const numberOfCurrencies = 100;
			const { currencyKeys, rates } = createRandomKeysAndRates(numberOfCurrencies);

			const instance = await ExchangeRates.new(owner, oracle, currencyKeys, rates, {
				from: deployerAccount,
			});

			for (let i = 0; i < currencyKeys.length; i++) {
				assert.bnEqual(await instance.rateForCurrency(currencyKeys[i]), rates[i]);
				const lastUpdatedTime = await instance.lastRateUpdateTimes.call(currencyKeys[i]);
				assert.isAtLeast(lastUpdatedTime.toNumber(), creationTime);
			}
		});
	});

	describe('updateRates()', () => {
		it('should be able to update rates of only one currency without affecting other rates', async () => {
			await fastForward(1);

			await instance.updateRates(
				[toBytes32('lABC'), toBytes32('lDEF'), toBytes32('lGHI')],
				[
					web3.utils.toWei('1.3', 'ether'),
					web3.utils.toWei('2.4', 'ether'),
					web3.utils.toWei('3.5', 'ether'),
				],
				timeSent,
				{ from: oracle }
			);

			await fastForward(10);
			const updatedTime = timeSent + 10;

			const updatedRate = '64.33';
			await instance.updateRates(
				[toBytes32('lABC')],
				[web3.utils.toWei(updatedRate, 'ether')],
				updatedTime,
				{ from: oracle }
			);

			const updatedTimelDEF = await instance.lastRateUpdateTimes.call(toBytes32('lDEF'));
			const updatedTimelGHI = await instance.lastRateUpdateTimes.call(toBytes32('lGHI'));

			assert.etherEqual(await instance.rateForCurrency(toBytes32('lABC')), updatedRate);
			assert.etherEqual(await instance.rateForCurrency(toBytes32('lDEF')), '2.4');
			assert.etherEqual(await instance.rateForCurrency(toBytes32('lGHI')), '3.5');

			const lastUpdatedTimeLABC = await instance.lastRateUpdateTimes.call(toBytes32('lABC'));
			assert.equal(lastUpdatedTimeLABC.toNumber(), updatedTime);
			const lastUpdatedTimeLDEF = await instance.lastRateUpdateTimes.call(toBytes32('lDEF'));
			assert.equal(lastUpdatedTimeLDEF.toNumber(), updatedTimelDEF.toNumber());
			const lastUpdatedTimeLGHI = await instance.lastRateUpdateTimes.call(toBytes32('lGHI'));
			assert.equal(lastUpdatedTimeLGHI.toNumber(), updatedTimelGHI.toNumber());
		});

		it('should be able to update rates of all currencies', async () => {
			await fastForward(1);

			await instance.updateRates(
				[toBytes32('lABC'), toBytes32('lDEF'), toBytes32('lGHI')],
				[
					web3.utils.toWei('1.3', 'ether'),
					web3.utils.toWei('2.4', 'ether'),
					web3.utils.toWei('3.5', 'ether'),
				],
				timeSent,
				{ from: oracle }
			);

			await fastForward(5);
			const updatedTime = timeSent + 5;

			const updatedRate1 = '64.33';
			const updatedRate2 = '2.54';
			const updatedRate3 = '10.99';
			await instance.updateRates(
				[toBytes32('lABC'), toBytes32('lDEF'), toBytes32('lGHI')],
				[
					web3.utils.toWei(updatedRate1, 'ether'),
					web3.utils.toWei(updatedRate2, 'ether'),
					web3.utils.toWei(updatedRate3, 'ether'),
				],
				updatedTime,
				{ from: oracle }
			);

			assert.etherEqual(await instance.rateForCurrency(toBytes32('lABC')), updatedRate1);
			assert.etherEqual(await instance.rateForCurrency(toBytes32('lDEF')), updatedRate2);
			assert.etherEqual(await instance.rateForCurrency(toBytes32('lGHI')), updatedRate3);

			const lastUpdatedTimeLABC = await instance.lastRateUpdateTimes.call(toBytes32('lABC'));
			assert.equal(lastUpdatedTimeLABC.toNumber(), updatedTime);
			const lastUpdatedTimeLDEF = await instance.lastRateUpdateTimes.call(toBytes32('lDEF'));
			assert.equal(lastUpdatedTimeLDEF.toNumber(), updatedTime);
			const lastUpdatedTimeLGHI = await instance.lastRateUpdateTimes.call(toBytes32('lGHI'));
			assert.equal(lastUpdatedTimeLGHI.toNumber(), updatedTime);
		});

		it('should revert when trying to set oUSD price', async () => {
			await fastForward(1);

			await assert.revert(
				instance.updateRates([oUSD], [web3.utils.toWei('1.0', 'ether')], timeSent, {
					from: oracle,
				})
			);
		});

		it('should emit RatesUpdated event when rate updated', async () => {
			const rates = [
				web3.utils.toWei('1.3', 'ether'),
				web3.utils.toWei('2.4', 'ether'),
				web3.utils.toWei('3.5', 'ether'),
			];

			const keys = ['lABC', 'lDEF', 'lGHI'];
			const currencyKeys = keys.map(toBytes32);
			const txn = await instance.updateRates(currencyKeys, rates, await currentTime(), {
				from: oracle,
			});

			assert.eventEqual(txn, 'RatesUpdated', {
				currencyKeys,
				newRates: rates,
			});
		});

		it('should be able to handle lots of currency updates', async () => {
			const numberOfCurrencies = 150;
			const { currencyKeys, rates } = createRandomKeysAndRates(numberOfCurrencies);

			const updatedTime = await currentTime();
			await instance.updateRates(currencyKeys, rates, updatedTime, { from: oracle });

			for (let i = 0; i < currencyKeys.length; i++) {
				assert.equal(await instance.rateForCurrency(currencyKeys[i]), rates[i]);
				const lastUpdatedTime = await instance.lastRateUpdateTimes.call(currencyKeys[i]);
				assert.equal(lastUpdatedTime.toNumber(), updatedTime);
			}
		});

		it('should revert when currency keys length != new rates length on update', async () => {
			await assert.revert(
				instance.updateRates(
					[oUSD, SNX, toBytes32('GOLD')],
					[web3.utils.toWei('1', 'ether'), web3.utils.toWei('0.2', 'ether')],
					await currentTime(),
					{ from: oracle }
				)
			);
		});

		it('should not be able to set exchange rate to 0 on update', async () => {
			await assert.revert(
				instance.updateRates(
					[toBytes32('ZERO')],
					[web3.utils.toWei('0', 'ether')],
					await currentTime(),
					{ from: oracle }
				)
			);
		});

		it('only oracle can update exchange rates', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: instance.updateRates,
				args: [
					[toBytes32('GOLD'), toBytes32('FOOL')],
					[web3.utils.toWei('10', 'ether'), web3.utils.toWei('0.9', 'ether')],
					timeSent,
				],
				address: oracle,
				accounts,
				skipPassCheck: true,
			});

			assert.etherNotEqual(await instance.rateForCurrency(toBytes32('GOLD')), '10');
			assert.etherNotEqual(await instance.rateForCurrency(toBytes32('FOOL')), '0.9');

			const updatedTime = await currentTime();

			await instance.updateRates(
				[toBytes32('GOLD'), toBytes32('FOOL')],
				[web3.utils.toWei('10', 'ether'), web3.utils.toWei('0.9', 'ether')],
				updatedTime,
				{ from: oracle }
			);
			assert.etherEqual(await instance.rateForCurrency(toBytes32('GOLD')), '10');
			assert.etherEqual(await instance.rateForCurrency(toBytes32('FOOL')), '0.9');

			const lastUpdatedTimeGOLD = await instance.lastRateUpdateTimes.call(toBytes32('GOLD'));
			assert.equal(lastUpdatedTimeGOLD.toNumber(), updatedTime);
			const lastUpdatedTimeFOOL = await instance.lastRateUpdateTimes.call(toBytes32('FOOL'));
			assert.equal(lastUpdatedTimeFOOL.toNumber(), updatedTime);
		});

		it('should not be able to update rates if they are too far in the future', async () => {
			const timeTooFarInFuture = (await currentTime()) + 10 * 61;
			await assert.revert(
				instance.updateRates(
					[toBytes32('GOLD')],
					[web3.utils.toWei('1', 'ether')],
					timeTooFarInFuture,
					{ from: oracle }
				)
			);
		});
	});

	// Changing the Oracle address

	describe('setOracle()', () => {
		it("only the owner should be able to change the oracle's address", async () => {
			await onlyGivenAddressCanInvoke({
				fnc: instance.setOracle,
				args: [oracle],
				address: owner,
				accounts,
				skipPassCheck: true,
			});

			await instance.setOracle(accountOne, { from: owner });

			assert.equal(await instance.oracle.call(), accountOne);
			assert.notEqual(await instance.oracle.call(), oracle);
		});

		it('should emit event on successful oracle address update', async () => {
			// Ensure oracle is set to oracle address originally
			await instance.setOracle(oracle, { from: owner });
			assert.equal(await instance.oracle.call(), oracle);

			const txn = await instance.setOracle(accountOne, { from: owner });
			assert.eventEqual(txn, 'OracleUpdated', {
				newOracle: accountOne,
			});
		});
	});

	describe('deleteRate()', () => {
		it('should be able to remove specific rate', async () => {
			const foolsRate = '0.002';
			const encodedRateGOLD = toBytes32('GOLD');

			await instance.updateRates(
				[encodedRateGOLD, toBytes32('FOOL')],
				[web3.utils.toWei('10.123', 'ether'), web3.utils.toWei(foolsRate, 'ether')],
				timeSent,
				{ from: oracle }
			);

			const beforeRate = await instance.rateForCurrency(encodedRateGOLD);
			const beforeRateUpdatedTime = await instance.lastRateUpdateTimes.call(encodedRateGOLD);

			await instance.deleteRate(encodedRateGOLD, { from: oracle });

			const afterRate = await instance.rateForCurrency(encodedRateGOLD);
			const afterRateUpdatedTime = await instance.lastRateUpdateTimes.call(encodedRateGOLD);
			assert.notEqual(afterRate, beforeRate);
			assert.equal(afterRate, '0');
			assert.notEqual(afterRateUpdatedTime, beforeRateUpdatedTime);
			assert.equal(afterRateUpdatedTime, '0');

			// Other rates are unaffected
			assert.etherEqual(await instance.rateForCurrency(toBytes32('FOOL')), foolsRate);
		});

		it('only oracle can delete a rate', async () => {
			// Assume that the contract is already set up with a valid oracle account called 'oracle'

			await instance.updateRates(
				[toBytes32('COOL')],
				[web3.utils.toWei('10.123', 'ether')],
				await currentTime(),
				{ from: oracle }
			);

			const encodedRateName = toBytes32('COOL');
			await assert.revert(instance.deleteRate(encodedRateName, { from: deployerAccount }));
			await assert.revert(instance.deleteRate(encodedRateName, { from: accountOne }));
			await assert.revert(instance.deleteRate(encodedRateName, { from: owner }));
			await instance.deleteRate(encodedRateName, { from: oracle });
		});

		it("deleting rate that doesn't exist causes revert", async () => {
			// This key shouldn't exist but let's do the best we can to ensure that it doesn't
			const encodedCurrencyKey = toBytes32('7NEQ');
			const currentRate = await instance.rateForCurrency(encodedCurrencyKey);
			if (currentRate > 0) {
				await instance.deleteRate(encodedCurrencyKey, { from: oracle });
			}

			// Ensure rate deletion attempt results in revert
			await assert.revert(instance.deleteRate(encodedCurrencyKey, { from: oracle }));
			assert.etherEqual(await instance.rateForCurrency(encodedCurrencyKey), '0');
		});

		it('should emit RateDeleted event when rate deleted', async () => {
			const updatedTime = await currentTime();
			const rate = 'GOLD';
			const encodedRate = toBytes32(rate);
			await instance.updateRates(
				[encodedRate],
				[web3.utils.toWei('10.123', 'ether')],
				updatedTime,
				{
					from: oracle,
				}
			);

			const txn = await instance.deleteRate(encodedRate, { from: oracle });
			assert.eventEqual(txn, 'RateDeleted', { currencyKey: encodedRate });
		});
	});

	describe('getting rates', () => {
		it('should be able to get exchange rate with key', async () => {
			const updatedTime = await currentTime();
			const encodedRate = toBytes32('GOLD');
			const rateValueEncodedStr = web3.utils.toWei('10.123', 'ether');
			await instance.updateRates([encodedRate], [rateValueEncodedStr], updatedTime, {
				from: oracle,
			});

			const rate = await instance.rateForCurrency(encodedRate);
			assert.equal(rate, rateValueEncodedStr);
		});

		it('all users should be able to get exchange rate with key', async () => {
			const updatedTime = await currentTime();
			const encodedRate = toBytes32('FETC');
			const rateValueEncodedStr = web3.utils.toWei('910.6661293879', 'ether');
			await instance.updateRates([encodedRate], [rateValueEncodedStr], updatedTime, {
				from: oracle,
			});

			await instance.rateForCurrency(encodedRate, { from: accountOne });
			await instance.rateForCurrency(encodedRate, { from: accountTwo });
			await instance.rateForCurrency(encodedRate, { from: oracle });
			await instance.rateForCurrency(encodedRate, { from: owner });
			await instance.rateForCurrency(encodedRate, { from: deployerAccount });
		});

		it('Fetching non-existent rate returns 0', async () => {
			const encodedRateKey = toBytes32('GOLD');
			const currentRate = await instance.rateForCurrency(encodedRateKey);
			if (currentRate > 0) {
				await instance.deleteRate(encodedRateKey, { from: oracle });
			}

			const rate = await instance.rateForCurrency(encodedRateKey);
			assert.equal(rate.toString(), '0');
		});
	});

	// Changing the rate stale period

	describe('setRateStalePeriod()', () => {
		it('should be able to change the rate stale period', async () => {
			const rateStalePeriod = 2010 * 2 * 60;

			const originalRateStalePeriod = await instance.rateStalePeriod.call();
			await instance.setRateStalePeriod(rateStalePeriod, { from: owner });
			const newRateStalePeriod = await instance.rateStalePeriod.call();
			assert.equal(newRateStalePeriod, rateStalePeriod);
			assert.notEqual(newRateStalePeriod, originalRateStalePeriod);
		});

		it('only owner is permitted to change the rate stale period', async () => {
			const rateStalePeriod = 2010 * 2 * 60;

			// Check not allowed from deployer
			await assert.revert(instance.setRateStalePeriod(rateStalePeriod, { from: deployerAccount }));
			await assert.revert(instance.setRateStalePeriod(rateStalePeriod, { from: oracle }));
			await assert.revert(instance.setRateStalePeriod(rateStalePeriod, { from: accountOne }));
			await instance.setRateStalePeriod(rateStalePeriod, { from: owner });
		});

		it('should emit event on successful rate stale period change', async () => {
			const rateStalePeriod = 2010 * 2 * 60;

			// Ensure oracle is set to oracle address originally
			const txn = await instance.setRateStalePeriod(rateStalePeriod, { from: owner });
			assert.eventEqual(txn, 'RateStalePeriodUpdated', {
				rateStalePeriod,
			});
		});
	});

	describe('rateIsStale()', () => {
		it('should never allow oUSD to go stale via rateIsStale', async () => {
			await fastForward(await instance.rateStalePeriod());
			const rateIsStale = await instance.rateIsStale(oUSD);
			assert.equal(rateIsStale, false);
		});

		it('check if a single rate is stale', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(30, { from: owner });
			const updatedTime = await currentTime();
			await instance.updateRates(
				[toBytes32('ABC')],
				[web3.utils.toWei('2', 'ether')],
				updatedTime,
				{
					from: oracle,
				}
			);
			await fastForward(31);

			const rateIsStale = await instance.rateIsStale(toBytes32('ABC'));
			assert.equal(rateIsStale, true);
		});

		it('check if a single rate is not stale', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(30, { from: owner });
			const updatedTime = await currentTime();
			await instance.updateRates(
				[toBytes32('ABC')],
				[web3.utils.toWei('2', 'ether')],
				updatedTime,
				{
					from: oracle,
				}
			);
			await fastForward(29);

			const rateIsStale = await instance.rateIsStale(toBytes32('ABC'));
			assert.equal(rateIsStale, false);
		});

		it('ensure rate is considered stale if not set', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(30, { from: owner });
			const encodedRateKey = toBytes32('GOLD');
			const currentRate = await instance.rateForCurrency(encodedRateKey);
			if (currentRate > 0) {
				await instance.deleteRate(encodedRateKey, { from: oracle });
			}

			const rateIsStale = await instance.rateIsStale(encodedRateKey);
			assert.equal(rateIsStale, true);
		});

		it('make sure anyone can check if rate is stale', async () => {
			const rateKey = toBytes32('ABC');
			await instance.rateIsStale(rateKey, { from: oracle });
			await instance.rateIsStale(rateKey, { from: owner });
			await instance.rateIsStale(rateKey, { from: deployerAccount });
			await instance.rateIsStale(rateKey, { from: accountOne });
			await instance.rateIsStale(rateKey, { from: accountTwo });
		});
	});

	describe('anyRateIsStale()', () => {
		it('should never allow oUSD to go stale via anyRateIsStale', async () => {
			const keysArray = [SNX, toBytes32('GOLD')];

			await instance.updateRates(
				keysArray,
				[web3.utils.toWei('0.1', 'ether'), web3.utils.toWei('0.2', 'ether')],
				await currentTime(),
				{ from: oracle }
			);
			assert.equal(await instance.anyRateIsStale(keysArray), false);

			await fastForward(await instance.rateStalePeriod());

			await instance.updateRates(
				[SNX, toBytes32('GOLD')],
				[web3.utils.toWei('0.1', 'ether'), web3.utils.toWei('0.2', 'ether')],
				await currentTime(),
				{ from: oracle }
			);

			// Even though oUSD hasn't been updated since the stale rate period has expired,
			// we expect that oUSD remains "not stale"
			assert.equal(await instance.anyRateIsStale(keysArray), false);
		});

		it('should be able to confirm no rates are stale from a subset', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(20, { from: owner });
			const encodedRateKeys1 = [
				toBytes32('ABC'),
				toBytes32('DEF'),
				toBytes32('GHI'),
				toBytes32('LMN'),
			];
			const encodedRateKeys2 = [
				toBytes32('OPQ'),
				toBytes32('RST'),
				toBytes32('UVW'),
				toBytes32('XYZ'),
			];
			const encodedRateKeys3 = [toBytes32('123'), toBytes32('456'), toBytes32('789')];
			const encodedRateValues1 = [
				web3.utils.toWei('1', 'ether'),
				web3.utils.toWei('2', 'ether'),
				web3.utils.toWei('3', 'ether'),
				web3.utils.toWei('4', 'ether'),
			];
			const encodedRateValues2 = [
				web3.utils.toWei('5', 'ether'),
				web3.utils.toWei('6', 'ether'),
				web3.utils.toWei('7', 'ether'),
				web3.utils.toWei('8', 'ether'),
			];
			const encodedRateValues3 = [
				web3.utils.toWei('9', 'ether'),
				web3.utils.toWei('10', 'ether'),
				web3.utils.toWei('11', 'ether'),
			];
			const updatedTime1 = await currentTime();
			await instance.updateRates(encodedRateKeys1, encodedRateValues1, updatedTime1, {
				from: oracle,
			});
			await fastForward(5);
			const updatedTime2 = await currentTime();
			await instance.updateRates(encodedRateKeys2, encodedRateValues2, updatedTime2, {
				from: oracle,
			});
			await fastForward(5);
			const updatedTime3 = await currentTime();
			await instance.updateRates(encodedRateKeys3, encodedRateValues3, updatedTime3, {
				from: oracle,
			});

			await fastForward(14);
			const rateIsStale = await instance.anyRateIsStale([...encodedRateKeys2, ...encodedRateKeys3]);
			assert.equal(rateIsStale, false);
		});

		it('should be able to confirm a single rate is stale from a set of rates', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(40, { from: owner });
			const encodedRateKeys1 = [
				toBytes32('ABC'),
				toBytes32('DEF'),
				toBytes32('GHI'),
				toBytes32('LMN'),
			];
			const encodedRateKeys2 = [toBytes32('OPQ')];
			const encodedRateKeys3 = [toBytes32('RST'), toBytes32('UVW'), toBytes32('XYZ')];
			const encodedRateValues1 = [
				web3.utils.toWei('1', 'ether'),
				web3.utils.toWei('2', 'ether'),
				web3.utils.toWei('3', 'ether'),
				web3.utils.toWei('4', 'ether'),
			];
			const encodedRateValues2 = [web3.utils.toWei('5', 'ether')];
			const encodedRateValues3 = [
				web3.utils.toWei('6', 'ether'),
				web3.utils.toWei('7', 'ether'),
				web3.utils.toWei('8', 'ether'),
			];

			const updatedTime2 = await currentTime();
			await instance.updateRates(encodedRateKeys2, encodedRateValues2, updatedTime2, {
				from: oracle,
			});
			await fastForward(20);

			const updatedTime1 = await currentTime();
			await instance.updateRates(encodedRateKeys1, encodedRateValues1, updatedTime1, {
				from: oracle,
			});
			await fastForward(15);
			const updatedTime3 = await currentTime();
			await instance.updateRates(encodedRateKeys3, encodedRateValues3, updatedTime3, {
				from: oracle,
			});

			await fastForward(6);
			const rateIsStale = await instance.anyRateIsStale([...encodedRateKeys2, ...encodedRateKeys3]);
			assert.equal(rateIsStale, true);
		});

		it('should be able to confirm a single rate (from a set of 1) is stale', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(40, { from: owner });
			const updatedTime = await currentTime();
			await instance.updateRates(
				[toBytes32('ABC')],
				[web3.utils.toWei('2', 'ether')],
				updatedTime,
				{
					from: oracle,
				}
			);
			await fastForward(41);

			const rateIsStale = await instance.anyRateIsStale([toBytes32('ABC')]);
			assert.equal(rateIsStale, true);
		});

		it('make sure anyone can check if any rates are stale', async () => {
			const rateKey = toBytes32('ABC');
			await instance.anyRateIsStale([rateKey], { from: oracle });
			await instance.anyRateIsStale([rateKey], { from: owner });
			await instance.anyRateIsStale([rateKey], { from: deployerAccount });
			await instance.anyRateIsStale([rateKey], { from: accountOne });
			await instance.anyRateIsStale([rateKey], { from: accountTwo });
		});

		it('ensure rates are considered stale if not set', async () => {
			// Set up rates for test
			await instance.setRateStalePeriod(40, { from: owner });
			const encodedRateKeys1 = [
				toBytes32('ABC'),
				toBytes32('DEF'),
				toBytes32('GHI'),
				toBytes32('LMN'),
			];
			const encodedRateValues1 = [
				web3.utils.toWei('1', 'ether'),
				web3.utils.toWei('2', 'ether'),
				web3.utils.toWei('3', 'ether'),
				web3.utils.toWei('4', 'ether'),
			];

			const updatedTime1 = await currentTime();
			await instance.updateRates(encodedRateKeys1, encodedRateValues1, updatedTime1, {
				from: oracle,
			});
			const rateIsStale = await instance.anyRateIsStale([...encodedRateKeys1, toBytes32('RST')]);
			assert.equal(rateIsStale, true);
		});
	});

	describe('is SelfDestructible', () => {
		it('should be destructable', async () => {
			// Check if the instance adheres to the destructable interface
			assert.exists(instance.initiateSelfDestruct);
			assert.exists(instance.setSelfDestructBeneficiary);
			assert.exists(instance.terminateSelfDestruct);
			assert.exists(instance.selfDestruct);

			assert.exists(instance.initiationTime);
			assert.exists(instance.selfDestructInitiated);
			assert.exists(instance.selfDestructBeneficiary);
		});
	});

	describe('lastRateUpdateTimesForCurrencies()', () => {
		it('should return correct last rate update times for specific currencies', async () => {
			const abc = toBytes32('lABC');
			const timeSent = await currentTime();
			const listOfKeys = [abc, toBytes32('lDEF'), toBytes32('lGHI')];
			await instance.updateRates(
				listOfKeys.slice(0, 2),
				[web3.utils.toWei('1.3', 'ether'), web3.utils.toWei('2.4', 'ether')],
				timeSent,
				{ from: oracle }
			);

			await fastForward(100);
			const newTimeSent = await currentTime();
			await instance.updateRates(
				listOfKeys.slice(2),
				[web3.utils.toWei('3.5', 'ether')],
				newTimeSent,
				{ from: oracle }
			);

			const lastUpdateTimes = await instance.lastRateUpdateTimesForCurrencies(listOfKeys);
			assert.notEqual(timeSent, newTimeSent);
			assert.equal(lastUpdateTimes.length, listOfKeys.length);
			assert.equal(lastUpdateTimes[0], timeSent);
			assert.equal(lastUpdateTimes[1], timeSent);
			assert.equal(lastUpdateTimes[2], newTimeSent);
		});

		it('should return correct last rate update time for a specific currency', async () => {
			const abc = toBytes32('lABC');
			const def = toBytes32('lDEF');
			const ghi = toBytes32('lGHI');
			const timeSent = await currentTime();
			await instance.updateRates(
				[abc, def],
				[web3.utils.toWei('1.3', 'ether'), web3.utils.toWei('2.4', 'ether')],
				timeSent,
				{ from: oracle }
			);
			await fastForward(10000);
			const timeSent2 = await currentTime();
			await instance.updateRates([ghi], [web3.utils.toWei('2.4', 'ether')], timeSent2, {
				from: oracle,
			});

			const [firstTS, secondTS] = await Promise.all([
				instance.lastRateUpdateTimes(abc),
				instance.lastRateUpdateTimes(ghi),
			]);
			assert.equal(firstTS, timeSent);
			assert.equal(secondTS, timeSent2);
		});
	});

	describe('effectiveValue()', () => {
		let timestamp;
		beforeEach(async () => {
			timestamp = await currentTime();
		});

		describe('when a price is sent to the oracle', () => {
			beforeEach(async () => {
				// Send a price update to guarantee we're not depending on values from outside this test.
				await instance.updateRates(
					['sAUD', 'sEUR', 'SNX'].map(toBytes32),
					['0.5', '1.25', '0.1'].map(toUnit),
					timestamp,
					{ from: oracle }
				);
			});
			it('should correctly calculate an exchange rate in effectiveValue()', async () => {
				// 1 oUSD should be worth 2 sAUD.
				assert.bnEqual(await instance.effectiveValue(oUSD, toUnit('1'), sAUD), toUnit('2'));

				// 10 SNX should be worth 1 oUSD.
				assert.bnEqual(await instance.effectiveValue(SNX, toUnit('10'), oUSD), toUnit('1'));

				// 2 sEUR should be worth 2.50 oUSD
				assert.bnEqual(await instance.effectiveValue(sEUR, toUnit('2'), oUSD), toUnit('2.5'));
			});

			it('should error when relying on a stale exchange rate in effectiveValue()', async () => {
				// Add stale period to the time to ensure we go stale.
				await fastForward((await instance.rateStalePeriod()) + 1);

				timestamp = await currentTime();

				// Update all rates except oUSD.
				await instance.updateRates([sEUR, SNX], ['1.25', '0.1'].map(toUnit), timestamp, {
					from: oracle,
				});

				const amountOfOikoss = toUnit('10');
				const amountOfEur = toUnit('0.8');

				// Should now be able to convert from SNX to sEUR since they are both not stale.
				assert.bnEqual(await instance.effectiveValue(SNX, amountOfOikoss, sEUR), amountOfEur);

				// But trying to convert from SNX to sAUD should fail as sAUD should be stale.
				await assert.revert(instance.effectiveValue(SNX, toUnit('10'), sAUD));
				await assert.revert(instance.effectiveValue(sAUD, toUnit('10'), SNX));
			});

			it('should revert when relying on a non-existant exchange rate in effectiveValue()', async () => {
				// Send a price update so we know what time we started with.
				await assert.revert(instance.effectiveValue(SNX, toUnit('10'), toBytes32('XYZ')));
			});
		});
	});

	describe('inverted prices', () => {
		const inverseRates = ['iBTC', 'iETH', 'sEUR', 'oBNB'];
		const [iBTC, iETH, sEUR, oBNB] = inverseRates.map(toBytes32);
		it('rateIsFrozen for a regular synth returns false', async () => {
			assert.equal(false, await instance.rateIsFrozen(sEUR));
		});
		it('and list of invertedKeys is empty', async () => {
			await assert.invalidOpcode(instance.invertedKeys(0));
		});
		describe('when attempting to add inverse synths', () => {
			it('ensure only the owner can invoke', async () => {
				await assert.revert(
					instance.setInversePricing(iBTC, toUnit('1'), toUnit('2'), toUnit('0.5'), false, false, {
						from: deployerAccount,
					})
				);
				await assert.revert(
					instance.setInversePricing(iBTC, toUnit('1'), toUnit('2'), toUnit('0.5'), false, false, {
						from: oracle,
					})
				);
				await assert.revert(
					instance.setInversePricing(iBTC, toUnit('1'), toUnit('2'), toUnit('0.5'), false, false, {
						from: accountOne,
					})
				);
			});
			it('ensure entryPoint be greater than 0', async () => {
				await assert.revert(
					instance.setInversePricing(iBTC, toUnit('0'), toUnit('150'), toUnit('10'), false, false, {
						from: owner,
					})
				);
			});
			it('ensure lowerLimit be greater than 0', async () => {
				await assert.revert(
					instance.setInversePricing(
						iBTC,
						toUnit('100'),
						toUnit('150'),
						toUnit('0'),
						false,
						false,
						{
							from: owner,
						}
					)
				);
			});
			it('ensure upperLimit be greater than the entryPoint', async () => {
				await assert.revert(
					instance.setInversePricing(
						iBTC,
						toUnit('100'),
						toUnit('100'),
						toUnit('10'),
						false,
						false,
						{
							from: owner,
						}
					)
				);
			});
			it('ensure upperLimit be less than double the entryPoint', async () => {
				await assert.revert(
					instance.setInversePricing(
						iBTC,
						toUnit('100'),
						toUnit('200'),
						toUnit('10'),
						false,
						false,
						{
							from: owner,
						}
					)
				);
			});
			it('ensure lowerLimit be less than the entryPoint', async () => {
				await assert.revert(
					instance.setInversePricing(
						iBTC,
						toUnit('100'),
						toUnit('150'),
						toUnit('100'),
						false,
						false,
						{
							from: owner,
						}
					)
				);
			});
		});

		describe('when two inverted synths are added', () => {
			// helper function to check rates are correct
			const assertRatesAreCorrect = async ({ currencyKeys, expectedRates, txn, frozen = [] }) => {
				// ensure all rates returned from contract are as expected
				const rates = await instance.ratesForCurrencies(currencyKeys);
				expectedRates.forEach((rate, i) => assert.bnEqual(rates[i], rate));

				const possibleFrozenEvents = frozen.reduce((memo, currencyKey) => {
					return memo.concat('InversePriceFrozen', {
						currencyKey,
					});
				}, []);

				const ratesUpdatedEvent = [
					'RatesUpdated',
					{
						currencyKeys,
						newRates: expectedRates,
					},
				];

				// ensure transaction emitted a RatesUpdated event and a list of possible frozen events
				const allEvents = possibleFrozenEvents.concat(ratesUpdatedEvent);
				assert[allEvents.length > 2 ? 'eventsEqual' : 'eventEqual'](txn, ...allEvents);
			};

			const setTxns = [];
			beforeEach(async () => {
				setTxns.push(
					await instance.setInversePricing(
						iBTC,
						toUnit(4000),
						toUnit(6500),
						toUnit(2300),
						false,
						false,
						{
							from: owner,
						}
					)
				);
				setTxns.push(
					await instance.setInversePricing(
						iETH,
						toUnit(200),
						toUnit(350),
						toUnit(75),
						false,
						false,
						{
							from: owner,
						}
					)
				);
			});
			it('both emit InversePriceConfigured events', async () => {
				assert.eventEqual(setTxns[0], 'InversePriceConfigured', {
					currencyKey: iBTC,
					entryPoint: toUnit(4000),
					upperLimit: toUnit(6500),
					lowerLimit: toUnit(2300),
				});
				assert.eventEqual(setTxns[1], 'InversePriceConfigured', {
					currencyKey: iETH,
					entryPoint: toUnit(200),
					upperLimit: toUnit(350),
					lowerLimit: toUnit(75),
				});
			});
			it('and the list of invertedKeys lists them both', async () => {
				assert.equal('iBTC', bytesToString(await instance.invertedKeys(0)));
				assert.equal('iETH', bytesToString(await instance.invertedKeys(1)));
				await assert.invalidOpcode(instance.invertedKeys(2));
			});
			it('rateIsFrozen must be false for both', async () => {
				assert.equal(false, await instance.rateIsFrozen(iBTC));
				assert.equal(false, await instance.rateIsFrozen(iETH));
			});
			describe('when another synth is added as frozen directly', () => {
				let txn;
				describe('with it set to freezeAtUpperLimit', () => {
					beforeEach(async () => {
						txn = await instance.setInversePricing(
							iBTC,
							toUnit(4000),
							toUnit(6500),
							toUnit(2300),
							true,
							true,
							{
								from: owner,
							}
						);
					});
					it('then the synth is frozen', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(false, await instance.rateIsFrozen(iETH));
					});
					it('and it emits a frozen event', () => {
						assert.eventEqual(txn.logs[1], 'InversePriceFrozen', {
							currencyKey: iBTC,
						});
					});
					it('and the rate for the synth is the upperLimit', async () => {
						const actual = await instance.ratesForCurrencies([iBTC]);
						assert.bnEqual(actual, toUnit(6500));
					});
				});
				describe('with it not set to freezeAtUpperLimit', () => {
					beforeEach(async () => {
						await instance.setInversePricing(
							iBTC,
							toUnit(4000),
							toUnit(6500),
							toUnit(2300),
							true,
							false,
							{
								from: owner,
							}
						);
					});
					it('then the synth is frozen', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(false, await instance.rateIsFrozen(iETH));
					});
					it('and the rate for the synth is the lowerLimit', async () => {
						const actual = await instance.ratesForCurrencies([iBTC]);
						assert.bnEqual(actual, toUnit(2300));
					});
				});
			});
			describe('when updateRates is called with an in-bounds update', () => {
				let txn;
				beforeEach(async () => {
					const rates = [4500.553, 225, 1.12, 4500.553].map(toUnit);
					const timeSent = await currentTime();
					txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
						from: oracle,
					});
				});
				it('regular and inverted rates should be updated correctly', async () => {
					await assertRatesAreCorrect({
						txn,
						currencyKeys: [iBTC, iETH, sEUR, oBNB],
						expectedRates: [3499.447, 175, 1.12, 4500.553].map(toUnit),
					});
				});
				it('rateIsFrozen must be false for both', async () => {
					assert.equal(false, await instance.rateIsFrozen(iBTC));
					assert.equal(false, await instance.rateIsFrozen(iETH));
				});
				describe('when setInversePricing is called to freeze a synth with a rate', () => {
					beforeEach(async () => {
						await instance.setInversePricing(
							iBTC,
							toUnit(4000),
							toUnit(6500),
							toUnit(2300),
							true,
							true,
							{
								from: owner,
							}
						);
					});
					it('then the synth is frozen', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(false, await instance.rateIsFrozen(iETH));
					});
					it('and the rate for the synth is the upperLimit - regardless of its old value', async () => {
						const actual = await instance.ratesForCurrencies([iBTC]);
						assert.bnEqual(actual, toUnit(6500));
					});
				});
			});
			describe('when updateRates is called with a lower out-of-bounds update', () => {
				let txn;
				beforeEach(async () => {
					const rates = [8050, 400, 1.12, 8050].map(toUnit);
					const timeSent = await currentTime();
					txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
						from: oracle,
					});
				});
				it('inverted rates must be set to the lower bounds', async () => {
					await assertRatesAreCorrect({
						txn,
						currencyKeys: [iBTC, iETH, sEUR, oBNB],
						expectedRates: [2300, 75, 1.12, 8050].map(toUnit),
						frozen: [iBTC, iETH],
					});
				});
				it('rateIsFrozen must be true for both', async () => {
					assert.equal(true, await instance.rateIsFrozen(iBTC));
					assert.equal(true, await instance.rateIsFrozen(iETH));
				});

				describe('when another updateRates is called with an in bounds update', () => {
					beforeEach(async () => {
						const rates = [3500, 300, 2.12, 3500].map(toUnit);
						const timeSent = await currentTime();
						txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
							from: oracle,
						});
					});
					it('inverted rates must remain frozen at the lower bounds', async () => {
						await assertRatesAreCorrect({
							txn,
							currencyKeys: [iBTC, iETH, sEUR, oBNB],
							expectedRates: [2300, 75, 2.12, 3500].map(toUnit),
						});
					});
					it('rateIsFrozen must be true for both', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(true, await instance.rateIsFrozen(iETH));
					});
				});
				describe('when another updateRates is called with an out of bounds update the other way', () => {
					beforeEach(async () => {
						const rates = [1000, 50, 2.3, 1000].map(toUnit);
						const timeSent = await currentTime();
						txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
							from: oracle,
						});
					});
					it('inverted rates must remain frozen at the lower bounds', async () => {
						await assertRatesAreCorrect({
							txn,
							currencyKeys: [iBTC, iETH, sEUR, oBNB],
							expectedRates: [2300, 75, 2.3, 1000].map(toUnit),
						});
					});
					it('rateIsFrozen must be true for both', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(true, await instance.rateIsFrozen(iETH));
					});
				});
				describe('when setInversePricing is called again for one of the frozen synths', () => {
					let setTxn;
					beforeEach(async () => {
						setTxn = await instance.setInversePricing(
							iBTC,
							toUnit(5000),
							toUnit(8900),
							toUnit(3000),
							false,
							false,
							{
								from: owner,
							}
						);
					});
					it('rateIsFrozen must be false for the updated one and true for the previously frozen one', async () => {
						assert.equal(false, await instance.rateIsFrozen(iBTC));
						assert.equal(true, await instance.rateIsFrozen(iETH));
					});

					it('it emits a InversePriceConfigured event', async () => {
						const currencyKey = 'iBTC';
						assert.eventEqual(setTxn, 'InversePriceConfigured', {
							currencyKey: toBytes32(currencyKey),
							entryPoint: toUnit(5000),
							upperLimit: toUnit(8900),
							lowerLimit: toUnit(3000),
						});
					});
					it('and the list of invertedKeys still lists them both', async () => {
						assert.equal('iBTC', bytesToString(await instance.invertedKeys(0)));
						assert.equal('iETH', bytesToString(await instance.invertedKeys(1)));
						await assert.invalidOpcode(instance.invertedKeys(2));
					});

					describe('when a price is received within bounds', () => {
						let txn;
						beforeEach(async () => {
							const rates = [1250, 201, 1.12, 1250].map(toUnit);
							const timeSent = await currentTime();
							txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
								from: oracle,
							});
						});
						it('then the inverted synth updates as it is no longer frozen and respects new entryPoint and limits', async () => {
							await assertRatesAreCorrect({
								txn,
								currencyKeys: [iBTC, iETH, sEUR, oBNB],
								expectedRates: [8750, 75, 1.12, 1250].map(toUnit),
							});
						});
						it('rateIsFrozen must be false', async () => {
							assert.equal(false, await instance.rateIsFrozen(iBTC));
						});

						describe('when a price is received out of bounds bounds', () => {
							let txn;
							beforeEach(async () => {
								const rates = [1000, 201, 1.12, 1250].map(toUnit);
								const timeSent = await currentTime();
								txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
									from: oracle,
								});
							});
							it('then the inverted freezes at new upper limit', async () => {
								await assertRatesAreCorrect({
									txn,
									currencyKeys: [iBTC, iETH, sEUR, oBNB],
									expectedRates: [8900, 75, 1.12, 1250].map(toUnit),
									frozen: [iBTC],
								});
							});
							it('rateIsFrozen must be true', async () => {
								assert.equal(true, await instance.rateIsFrozen(iBTC));
							});
						});
					});
				});
			});
			describe('when updateRates is called with an upper out-of-bounds update', () => {
				let txn;
				beforeEach(async () => {
					const rates = [1200, 45, 1.12, 1200].map(toUnit);
					const timeSent = await currentTime();
					txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
						from: oracle,
					});
				});
				it('inverted rates must be set to the upper bounds', async () => {
					await assertRatesAreCorrect({
						txn,
						currencyKeys: [iBTC, iETH, sEUR, oBNB],
						expectedRates: [6500, 350, 1.12, 1200].map(toUnit),
						frozen: [iBTC, iETH],
					});
				});
				it('rateIsFrozen must be true for both', async () => {
					assert.equal(true, await instance.rateIsFrozen(iBTC));
					assert.equal(true, await instance.rateIsFrozen(iETH));
				});

				describe('when another updateRates is called with an in bounds update', () => {
					beforeEach(async () => {
						const rates = [3500, 300, 2.12, 3500].map(toUnit);
						const timeSent = await currentTime();
						txn = await instance.updateRates([iBTC, iETH, sEUR, oBNB], rates, timeSent, {
							from: oracle,
						});
					});
					it('inverted rates must remain frozen at the upper bounds', async () => {
						await assertRatesAreCorrect({
							txn,
							currencyKeys: [iBTC, iETH, sEUR, oBNB],
							expectedRates: [6500, 350, 2.12, 3500].map(toUnit),
						});
					});
					it('rateIsFrozen must be true for both', async () => {
						assert.equal(true, await instance.rateIsFrozen(iBTC));
						assert.equal(true, await instance.rateIsFrozen(iETH));
					});
				});

				describe('when iBTC is attempted removal by a non owner', () => {
					it('ensure only the owner can invoke', async () => {
						await assert.revert(
							instance.removeInversePricing(iBTC, {
								from: deployerAccount,
							})
						);
						await assert.revert(
							instance.removeInversePricing(iBTC, {
								from: oracle,
							})
						);
						await assert.revert(
							instance.removeInversePricing(iBTC, {
								from: accountOne,
							})
						);
					});
				});

				describe('when a regular (non-inverse) synth is removed by the owner', () => {
					it('then it reverts', async () => {
						await assert.revert(
							instance.removeInversePricing(sEUR, {
								from: owner,
							})
						);
						await assert.revert(
							instance.removeInversePricing(oBNB, {
								from: owner,
							})
						);
					});
				});

				describe('when iBTC is removed by the owner', () => {
					let removeTxn;
					beforeEach(async () => {
						removeTxn = await instance.removeInversePricing(iBTC, {
							from: owner,
						});
					});
					it('it emits a InversePriceConfigured event', async () => {
						assert.eventEqual(removeTxn, 'InversePriceConfigured', {
							currencyKey: iBTC,
							entryPoint: 0,
							upperLimit: 0,
							lowerLimit: 0,
						});
					});
					it('and the list of invertedKeys contains only iETH', async () => {
						assert.equal('iETH', bytesToString(await instance.invertedKeys(0)));
						await assert.invalidOpcode(instance.invertedKeys(1));
					});
					it('rateIsFrozen must be false for iBTC but still true for iETH', async () => {
						assert.equal(false, await instance.rateIsFrozen(iBTC));
						assert.equal(true, await instance.rateIsFrozen(iETH));
					});
				});
			});
		});
	});

	describe('pricing aggregators', () => {
		it('only an owner can add an aggregator', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: instance.addAggregator,
				args: [sJPY, aggregatorJPY.address],
				accounts,
				address: owner,
			});
		});

		describe('when a user queries the first entry in aggregatorKeys', () => {
			it('then it is empty', async () => {
				await assert.invalidOpcode(instance.aggregatorKeys(0));
			});
		});

		describe('when the owner attempts to add an invalid address for sJPY ', () => {
			it('then zero address is invalid', async () => {
				await assert.revert(
					instance.addAggregator(sJPY, ZERO_ADDRESS, {
						from: owner,
					})
				);
			});
			it('and a non-aggregator address is invalid', async () => {
				await assert.revert(
					instance.addAggregator(sJPY, instance.address, {
						from: owner,
					})
				);
			});
		});

		describe('when the owner adds sJPY added as an aggregator', () => {
			let txn;
			beforeEach(async () => {
				txn = await instance.addAggregator(sJPY, aggregatorJPY.address, {
					from: owner,
				});
			});

			it('then the list of aggregatorKeys lists it', async () => {
				assert.equal('sJPY', bytesToString(await instance.aggregatorKeys(0)));
				await assert.invalidOpcode(instance.aggregatorKeys(1));
			});

			it('and the AggregatorAdded event is emitted', () => {
				assert.eventEqual(txn, 'AggregatorAdded', {
					currencyKey: sJPY,
					aggregator: aggregatorJPY.address,
				});
			});

			it('only an owner can remove an aggregator', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: instance.removeAggregator,
					args: [sJPY],
					accounts,
					address: owner,
				});
			});

			describe('when the owner tries to remove an invalid aggregator', () => {
				it('then it reverts', async () => {
					await assert.revert(
						instance.removeAggregator(sXTZ, { from: owner }),
						'No aggregator exists for key'
					);
				});
			});

			describe('when the owner adds sXTZ as an aggregator', () => {
				beforeEach(async () => {
					txn = await instance.addAggregator(sXTZ, aggregatorXTZ.address, {
						from: owner,
					});
				});

				it('then the list of aggregatorKeys lists it also', async () => {
					assert.equal('sJPY', bytesToString(await instance.aggregatorKeys(0)));
					assert.equal('sXTZ', bytesToString(await instance.aggregatorKeys(1)));
					await assert.invalidOpcode(instance.aggregatorKeys(2));
				});

				it('and the AggregatorAdded event is emitted', () => {
					assert.eventEqual(txn, 'AggregatorAdded', {
						currencyKey: sXTZ,
						aggregator: aggregatorXTZ.address,
					});
				});

				describe('when the ratesAndStaleForCurrencies is queried', () => {
					let response;
					beforeEach(async () => {
						response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
					});

					it('then the rates are stale', () => {
						assert.equal(response[1], true);
					});

					it('and both are zero', () => {
						assert.equal(response[0][0], '0');
						assert.equal(response[0][1], '0');
					});
				});

				describe('when the aggregator price is set for sJPY', () => {
					const newRate = 111;
					let timestamp;
					beforeEach(async () => {
						timestamp = await currentTime();
						// Multiply by 1e8 to match Chainlink's price aggregation
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(newRate), timestamp);
					});
					describe('when the ratesAndStaleForCurrencies is queried', () => {
						let response;
						beforeEach(async () => {
							response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
						});

						it('then the rates are still stale', () => {
							assert.equal(response[1], true);
						});

						it('yet one price is populated', () => {
							assert.bnEqual(response[0][0], toUnit(newRate.toString()));
							assert.equal(response[0][1], '0');
						});
					});
					describe('when the aggregator price is set for sXTZ', () => {
						const newRateXTZ = 222;
						let timestampXTZ;
						beforeEach(async () => {
							await fastForward(50);
							timestampXTZ = await currentTime();
							// Multiply by 1e8 to match Chainlink's price aggregation
							await aggregatorXTZ.setLatestAnswer(
								convertToAggregatorPrice(newRateXTZ),
								timestampXTZ
							);
						});
						describe('when the ratesAndStaleForCurrencies is queried', () => {
							let response;
							beforeEach(async () => {
								response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
							});

							it('then the rates are no longer stale', () => {
								assert.equal(response[1], false);
							});

							it('and both prices are populated', () => {
								assert.bnEqual(response[0][0], toUnit(newRate.toString()));
								assert.bnEqual(response[0][1], toUnit(newRateXTZ.toString()));
							});
						});

						describe('when the aggregator is removed for sJPY', () => {
							beforeEach(async () => {
								txn = await instance.removeAggregator(sJPY, {
									from: owner,
								});
							});
							it('then the AggregatorRemoved event is emitted', () => {
								assert.eventEqual(txn, 'AggregatorRemoved', {
									currencyKey: sJPY,
									aggregator: aggregatorJPY.address,
								});
							});
							describe('when a user queries the aggregatorKeys', () => {
								it('then only sXTZ is left', async () => {
									assert.equal('sXTZ', bytesToString(await instance.aggregatorKeys(0)));
									await assert.invalidOpcode(instance.aggregatorKeys(1));
								});
							});
							describe('when the ratesAndStaleForCurrencies is queried', () => {
								let response;
								beforeEach(async () => {
									response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
								});

								it('then the rates are stale again', () => {
									assert.equal(response[1], true);
								});

								it('and JPY is 0 while the other is fine', () => {
									assert.equal(response[0][0], '0');
									assert.bnEqual(response[0][1], toUnit(newRateXTZ.toString()));
								});
							});
						});
					});
				});
			});

			describe('when the aggregator price is set to set a specific number (with support for 8 decimals)', () => {
				const newRate = 123.456;
				let timestamp;
				beforeEach(async () => {
					timestamp = await currentTime();
					// Multiply by 1e8 to match Chainlink's price aggregation
					await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(newRate), timestamp);
				});

				describe('when the price is fetched for sJPY', () => {
					it('the specific number is returned with 18 decimals', async () => {
						const result = await instance.rateForCurrency(sJPY, {
							from: accountOne,
						});
						assert.bnEqual(result, toUnit(newRate.toString()));
					});
					it('and the timestamp is the latest', async () => {
						const result = await instance.lastRateUpdateTimes(sJPY, {
							from: accountOne,
						});
						assert.bnEqual(result.toNumber(), timestamp);
					});
				});
			});
		});

		describe('when a price already exists for sJPY', () => {
			const oldPrice = 100;
			let timeOldSent;
			beforeEach(async () => {
				timeOldSent = await currentTime();

				await instance.updateRates([sJPY], [web3.utils.toWei(oldPrice.toString())], timeOldSent, {
					from: oracle,
				});
			});
			describe('when the ratesAndStaleForCurrencies is queried with sJPY', () => {
				let response;
				beforeEach(async () => {
					response = await instance.ratesAndStaleForCurrencies([sJPY]);
				});

				it('then the rates are NOT stale', () => {
					assert.equal(response[1], false);
				});

				it('and equal to the value', () => {
					assert.bnEqual(response[0][0], web3.utils.toWei(oldPrice.toString()));
				});
			});
			describe('when the price is inspected for sJPY', () => {
				it('then the price is returned as expected', async () => {
					const result = await instance.rateForCurrency(sJPY, {
						from: accountOne,
					});
					assert.equal(result.toString(), toUnit(oldPrice));
				});
				it('then the timestamp is returned as expected', async () => {
					const result = await instance.lastRateUpdateTimes(sJPY, {
						from: accountOne,
					});
					assert.equal(result.toNumber(), timeOldSent);
				});
			});

			describe('when sJPY added as an aggregator (replacing existing)', () => {
				beforeEach(async () => {
					await instance.addAggregator(sJPY, aggregatorJPY.address, {
						from: owner,
					});
				});
				describe('when the price is fetched for sJPY', () => {
					it('0 is returned', async () => {
						const result = await instance.rateForCurrency(sJPY, {
							from: accountOne,
						});
						assert.equal(result.toNumber(), 0);
					});
				});
				describe('when the timestamp is fetched for sJPY', () => {
					it('0 is returned', async () => {
						const result = await instance.lastRateUpdateTimes(sJPY, {
							from: accountOne,
						});
						assert.equal(result.toNumber(), 0);
					});
				});
				describe('when the ratesAndStaleForCurrencies is queried with sJPY', () => {
					let response;
					beforeEach(async () => {
						response = await instance.ratesAndStaleForCurrencies([sJPY]);
					});

					it('then the rates are stale', () => {
						assert.equal(response[1], true);
					});

					it('with no value', () => {
						assert.bnEqual(response[0][0], '0');
					});
				});

				describe('when the aggregator price is set to set a specific number (with support for 8 decimals)', () => {
					const newRate = 9.55;
					let timestamp;
					beforeEach(async () => {
						await fastForward(50);
						timestamp = await currentTime();
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(newRate), timestamp);
					});

					describe('when the price is fetched for sJPY', () => {
						it('the new aggregator rate is returned instead of the old price', async () => {
							const result = await instance.rateForCurrency(sJPY, {
								from: accountOne,
							});
							assert.bnEqual(result, toUnit(newRate.toString()));
						});
						it('and the timestamp is the new one', async () => {
							const result = await instance.lastRateUpdateTimes(sJPY, {
								from: accountOne,
							});
							assert.bnEqual(result.toNumber(), timestamp);
						});
					});

					describe('when the ratesAndStaleForCurrencies is queried with sJPY', () => {
						let response;
						beforeEach(async () => {
							response = await instance.ratesAndStaleForCurrencies([sJPY]);
						});

						it('then the rates are NOT stale', () => {
							assert.equal(response[1], false);
						});

						it('and equal to the value', () => {
							assert.bnEqual(response[0][0], toUnit(newRate.toString()));
						});
					});

					describe('when the aggregator is removed for sJPY', () => {
						beforeEach(async () => {
							await instance.removeAggregator(sJPY, {
								from: owner,
							});
						});
						describe('when a user queries the first entry in aggregatorKeys', () => {
							it('then they are empty', async () => {
								await assert.invalidOpcode(instance.aggregatorKeys(0));
							});
						});
						describe('when the price is inspected for sJPY', () => {
							it('then the old price is returned', async () => {
								const result = await instance.rateForCurrency(sJPY, {
									from: accountOne,
								});
								assert.equal(result.toString(), toUnit(oldPrice));
							});
							it('and the timestamp is returned as expected', async () => {
								const result = await instance.lastRateUpdateTimes(sJPY, {
									from: accountOne,
								});
								assert.equal(result.toNumber(), timeOldSent);
							});
						});
						describe('when the ratesAndStaleForCurrencies is queried with sJPY', () => {
							let response;
							beforeEach(async () => {
								response = await instance.ratesAndStaleForCurrencies([sJPY]);
							});

							it('then the rates are NOT stale', () => {
								assert.equal(response[1], false);
							});

							it('and equal to the old value', () => {
								assert.bnEqual(response[0][0], web3.utils.toWei(oldPrice.toString()));
							});
						});
					});
				});
			});

			describe('when sXTZ added as an aggregator', () => {
				beforeEach(async () => {
					await instance.addAggregator(sXTZ, aggregatorXTZ.address, {
						from: owner,
					});
				});
				describe('when the ratesAndStaleForCurrencies is queried with sJPY and sXTZ', () => {
					let response;
					beforeEach(async () => {
						response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
					});

					it('then the rates are stale', () => {
						assert.equal(response[1], true);
					});

					it('with sXTZ having no value', () => {
						assert.bnEqual(response[0][0], web3.utils.toWei(oldPrice.toString()));
						assert.bnEqual(response[0][1], '0');
					});
				});

				describe('when the aggregator price is set to set for sXTZ', () => {
					const newRate = 99;
					let timestamp;
					beforeEach(async () => {
						await fastForward(50);
						timestamp = await currentTime();
						await aggregatorXTZ.setLatestAnswer(convertToAggregatorPrice(newRate), timestamp);
					});

					describe('when the ratesAndStaleForCurrencies is queried with sJPY and sXTZ', () => {
						let response;
						beforeEach(async () => {
							response = await instance.ratesAndStaleForCurrencies([sJPY, sXTZ]);
						});

						it('then the rates are NOT stale', () => {
							assert.equal(response[1], false);
						});

						it('and equal to the values', () => {
							assert.bnEqual(response[0][0], toUnit(oldPrice.toString()));
							assert.bnEqual(response[0][1], toUnit(newRate.toString()));
						});
					});
				});
			});
		});
	});

	describe('roundIds for historical rates', () => {
		it('getCurrentRoundId() by default is 0 for all synths except oUSD which is 1', async () => {
			// Note: rates that were set in the truffle migration will be at 1, so we need to check
			// other synths
			assert.equal(await instance.getCurrentRoundId(sJPY), '0');
			assert.equal(await instance.getCurrentRoundId(oBNB), '0');
			assert.equal(await instance.getCurrentRoundId(oUSD), '1');
		});
		describe('given an aggregator exists for sJPY', () => {
			beforeEach(async () => {
				await instance.addAggregator(sJPY, aggregatorJPY.address, {
					from: owner,
				});
			});
			describe('and it has been given three successive rates a second apart', () => {
				let timestamp;

				beforeEach(async () => {
					timestamp = 1000;
					for (let i = 0; i < 3; i++) {
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(100 + i), timestamp + i);
					}
				});

				describe('and the oBNB rate (non-aggregator) has been set three times directly also', () => {
					let timestamp;

					beforeEach(async () => {
						for (let i = 0; i < 3; i++) {
							timestamp = 10000;
							await instance.updateRates([oBNB], [toUnit((1000 + i).toString())], timestamp + i, {
								from: oracle,
							});
						}
					});
					describe('getCurrentRoundId())', () => {
						describe('when invoked for an aggregator', () => {
							it('getCurrentRound() returns the last entry', async () => {
								await assert.equal((await instance.getCurrentRoundId(sJPY)).toString(), '3');
							});
						});
						describe('when invoked for a regular price', () => {
							it('getCurrentRound() returns the last entry', async () => {
								await assert.equal((await instance.getCurrentRoundId(oBNB)).toString(), '3');
							});
						});
					});
					describe('rateAndTimestampAtRound()', () => {
						it('when invoked for no price, returns no rate and no tme', async () => {
							const { rate, time } = await instance.rateAndTimestampAtRound(toBytes32('TEST'), '0');
							assert.equal(rate, '0');
							assert.equal(time, '0');
						});
						it('when invoked for an aggregator', async () => {
							const assertRound = async ({ roundId }) => {
								const { rate, time } = await instance.rateAndTimestampAtRound(
									sJPY,
									roundId.toString()
								);
								assert.bnEqual(rate, toUnit((100 + roundId - 1).toString()));
								assert.bnEqual(time, toBN(1000 + roundId - 1));
							};
							await assertRound({ roundId: 1 });
							await assertRound({ roundId: 2 });
							await assertRound({ roundId: 3 });
						});
						it('when invoked for a regular price', async () => {
							const assertRound = async ({ roundId }) => {
								const { rate, time } = await instance.rateAndTimestampAtRound(
									oBNB,
									roundId.toString()
								);
								assert.bnEqual(rate, toUnit((1000 + roundId - 1).toString()));
								assert.bnEqual(time, toBN(10000 + roundId - 1));
							};
							await assertRound({ roundId: 1 });
							await assertRound({ roundId: 2 });
							await assertRound({ roundId: 3 });
						});
					});
				});
			});

			describe('and both the aggregator and regualr prices have been given three rates, 30seconds apart', () => {
				beforeEach(async () => {
					await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(100), 30); // round 1 for sJPY
					await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(200), 60); // round 2 for sJPY
					await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(300), 90); // round 3 for sJPY

					await instance.updateRates([oBNB], [toUnit('1000')], '30', { from: oracle }); // round 1 for oBNB
					await instance.updateRates([oBNB], [toUnit('2000')], '60', { from: oracle }); // round 2 for oBNB
					await instance.updateRates([oBNB], [toUnit('3000')], '90', { from: oracle }); // round 3 for oBNB
				});

				describe('getLastRoundIdBeforeElapsedSecs()', () => {
					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the first round and a waiting time of less than 30s', () => {
						it('then it receives round 1 - no change ', async () => {
							// assert both aggregated price and regular prices work as expected
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '1', 40, 10)).toString(),
								'1'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 40, 10)).toString(),
								'1'
							);
						});
					});

					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the first round and a waiting time of 30s exactly', () => {
						it('then it receives round 2 ', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '1', 40, 20)).toString(),
								'2'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 40, 20)).toString(),
								'2'
							);
						});
					});

					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the second round and a waiting time of 30s exactly', () => {
						it('then it receives round 3', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '2', 65, 25)).toString(),
								'3'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '2', 65, 25)).toString(),
								'3'
							);
						});
					});

					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the first round and a waiting time between 30s to 60s', () => {
						it('then it receives round 2 ', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '1', 40, 40)).toString(),
								'2'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 40, 40)).toString(),
								'2'
							);
						});
					});
					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the first round and a waiting time of 60s exactly', () => {
						it('then it receives round 3 ', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '1', 50, 40)).toString(),
								'3'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 50, 40)).toString(),
								'3'
							);
						});
					});
					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the first round and a waiting time beyond 60s', () => {
						it('then it receives round 3 as well ', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '1', 55, 6000)).toString(),
								'3'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 50, 40)).toString(),
								'3'
							);
						});
					});
					describe('when getLastRoundIdBeforeElapsedSecs() is invoked with the third round and a waiting time beyond 60s', () => {
						it('then it still receives round 3', async () => {
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(sJPY, '3', 180, 9000)).toString(),
								'3'
							);
							assert.equal(
								(await instance.getLastRoundIdBeforeElapsedSecs(oBNB, '1', 50, 40)).toString(),
								'3'
							);
						});
					});
				});
			});
			describe('effectiveValueAtRound()', () => {
				describe('when both the aggregator and regular prices have been give three rates with current timestamps', () => {
					beforeEach(async () => {
						let timestamp = await currentTime();
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(100), timestamp); // round 1 for sJPY
						await instance.updateRates([oBNB], [toUnit('1000')], timestamp, { from: oracle }); // round 1 for oBNB

						await fastForward(120);
						timestamp = await currentTime();
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(200), timestamp); // round 2 for sJPY
						await instance.updateRates([oBNB], [toUnit('2000')], timestamp, { from: oracle }); // round 2 for oBNB

						await fastForward(120);
						timestamp = await currentTime();
						await aggregatorJPY.setLatestAnswer(convertToAggregatorPrice(300), timestamp); // round 3 for sJPY
						await instance.updateRates([oBNB], [toUnit('4000')], timestamp, { from: oracle }); // round 3 for oBNB
					});
					it('accepts various changes to src roundId', async () => {
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '1', '1'),
							toUnit('0.1')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '2', '1'),
							toUnit('0.2')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '3', '1'),
							toUnit('0.3')
						);
					});
					it('accepts various changes to dest roundId', async () => {
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '1', '1'),
							toUnit('0.1')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '1', '2'),
							toUnit('0.05')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '1', '3'),
							toUnit('0.025')
						);
					});
					it('and combinations therein', async () => {
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '2', '2'),
							toUnit('0.1')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '3', '3'),
							toUnit('0.075')
						);
						assert.bnEqual(
							await instance.effectiveValueAtRound(sJPY, toUnit('1'), oBNB, '3', '2'),
							toUnit('0.15')
						);
					});
				});
			});
		});
	});
});
