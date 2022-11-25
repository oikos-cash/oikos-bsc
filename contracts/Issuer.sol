pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./interfaces/IIssuer.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/ISynth.sol";
import "./interfaces/IOikos.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IOikosState.sol";
import "./interfaces/IExchanger.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./IssuanceEternalStorage.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IBNBCollateral.sol";
import "./interfaces/IRewardEscrow.sol";
import "./interfaces/IHasBalance.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/ILiquidations.sol";
import "./interfaces/IOikosDebtShare.sol";
import "./interfaces/IDebtCache.sol";

interface IIssuerInternalDebtCache {
    function updateCachedSynthDebtWithRate(bytes32 currencyKey, uint currencyRate) external;

    function updateCachedSynthDebtsWithRates(bytes32[] calldata currencyKeys, uint[] calldata currencyRates) external;

    function updateDebtCacheValidity(bool currentlyInvalid) external;

    function cacheInfo()
        external
        view
        returns (
            uint cachedDebt,
            uint timestamp,
            bool isInvalid,
            bool isStale
        );
}

// https://docs.oikos.cash/contracts/Issuer
contract Issuer is Owned, MixinResolver, IIssuer {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 private constant oUSD = "oUSD";
    bytes32 private constant oETH = "oETH";

    bytes32 public constant LAST_ISSUE_EVENT = "LAST_ISSUE_EVENT";

    // Minimum Stake time may not exceed 1 weeks.
    uint public constant MAX_MINIMUM_STAKING_TIME = 1 weeks;

    uint public minimumStakeTime = 24 hours; // default minimum waiting period after issuing synths

    // Available Synths which can be used with the system
    ISynth[] public availableSynths;
    mapping(bytes32 => ISynth) public synths;
    mapping(address => bytes32) public synthsByAddress;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_OIKOS = "Oikos";
    bytes32 private constant CONTRACT_EXCHANGER = "Exchanger";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_OIKOSSTATE = "OikosState";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_ISSUANCEETERNALSTORAGE = "IssuanceEternalStorage";
    bytes32 private constant CONTRACT_ETHERCOLLATERAL = "BNBCollateral";
    bytes32 private constant CONTRACT_REWARDESCROW = "RewardEscrow";
    bytes32 private constant CONTRACT_OIKOSESCROW = "OikosEscrow";
    bytes32 private constant CONTRACT_LIQUIDATIONS = "Liquidations";
    bytes32 private constant CONTRACT_ESCROW_VX = "OikosEscrowVx";
    bytes32 private constant CONTRACT_OIKOSDEBTSHARE = "OikosDebtShare";
    bytes32 private constant CONTRACT_DEBTCACHE = "DebtCache";


    bytes32[24] private addressesToCache = [
        CONTRACT_OIKOS,
        CONTRACT_EXCHANGER,
        CONTRACT_EXRATES,
        CONTRACT_OIKOSSTATE,
        CONTRACT_FEEPOOL,
        CONTRACT_DELEGATEAPPROVALS,
        CONTRACT_ISSUANCEETERNALSTORAGE,
        CONTRACT_ETHERCOLLATERAL,
        CONTRACT_REWARDESCROW,
        CONTRACT_OIKOSESCROW,
        CONTRACT_LIQUIDATIONS,
        CONTRACT_OIKOSDEBTSHARE,
        CONTRACT_DEBTCACHE
    ];

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver, addressesToCache) {}

    /* ========== VIEWS ========== */
    function oikos() internal view returns (IOikos) {
        return IOikos(resolver.requireAndGetAddress(CONTRACT_OIKOS, "Missing Oikos address"));
    }

    function oikosERC20() internal view returns (IERC20) {
        return IERC20(resolver.requireAndGetAddress(CONTRACT_OIKOS, "Missing Oikos address"));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress(CONTRACT_EXCHANGER, "Missing Exchanger address"));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(resolver.requireAndGetAddress(CONTRACT_EXRATES, "Missing ExchangeRates address"));
    }

    function oikosState() internal view returns (IOikosState) {
        return IOikosState(resolver.requireAndGetAddress(CONTRACT_OIKOSSTATE, "Missing OikosState address"));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(resolver.requireAndGetAddress(CONTRACT_FEEPOOL, "Missing FeePool address"));
    }

    function liquidations() internal view returns (ILiquidations) {
        return ILiquidations(resolver.requireAndGetAddress(CONTRACT_LIQUIDATIONS, "Missing Liquidations address"));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(resolver.requireAndGetAddress(CONTRACT_DELEGATEAPPROVALS, "Missing DelegateApprovals address"));
    }

    function oikosDebtShare() internal view returns (IOikosDebtShare) {
        return IOikosDebtShare(resolver.requireAndGetAddress(CONTRACT_OIKOSDEBTSHARE, "Missing OikosDebtShare address"));
    }

    function issuanceEternalStorage() internal view returns (IssuanceEternalStorage) {
        return
            IssuanceEternalStorage(
                resolver.requireAndGetAddress(CONTRACT_ISSUANCEETERNALSTORAGE, "Missing IssuanceEternalStorage address")
            );
    }

    function debtCache() internal view returns (IIssuerInternalDebtCache) {
        return IIssuerInternalDebtCache(resolver.requireAndGetAddress(CONTRACT_DEBTCACHE, "Missing DebtCache address"));
    }

    function issuanceRatio() external view returns (uint) {
        return 0.125 ether;
    }

    function etherCollateral() internal view returns (IBNBCollateral) {
        return IBNBCollateral(resolver.requireAndGetAddress(CONTRACT_ETHERCOLLATERAL, "Missing EtherCollateral address"));
    }

    function rewardEscrow() internal view returns (IRewardEscrow) {
        return IRewardEscrow(resolver.requireAndGetAddress(CONTRACT_REWARDESCROW, "Missing RewardEscrow address"));
    }

    function oikosEscrow() internal view returns (IHasBalance) {
        return IHasBalance(resolver.requireAndGetAddress(CONTRACT_OIKOSESCROW, "Missing OikosEscrow address"));
    }

    function oikosEscrowVx() internal view returns (IHasBalance) {
        return IHasBalance(resolver.requireAndGetAddress(CONTRACT_ESCROW_VX, "Missing OikosEscrowVx address"));
    }

    function getSynths(bytes32[] calldata currencyKeys) external view returns (ISynth[] memory) {
        uint numKeys = currencyKeys.length;
        ISynth[] memory addresses = new ISynth[](numKeys);

        for (uint i = 0; i < numKeys; i++) {
            addresses[i] = synths[currencyKeys[i]];
        }

        return addresses;
    }

    function _availableCurrencyKeysWithOptionalOKS(bool withOKS) internal view returns (bytes32[] memory) {
        bytes32[] memory currencyKeys = new bytes32[](availableSynths.length + (withOKS ? 1 : 0));

        for (uint i = 0; i < availableSynths.length; i++) {
            currencyKeys[i] = synthsByAddress[address(availableSynths[i])];
        }

        if (withOKS) {
            currencyKeys[availableSynths.length] = "OKS";
        }

        return currencyKeys;
    }

    // function _totalIssuedSynths(bytes32 currencyKey, bool excludeEtherCollateral)
    //     internal
    //     view
    //     returns (uint totalIssued, bool anyRateIsStale)
    // {
    //     uint total = 0;
    //     uint currencyRate;

    //     bytes32[] memory synthsAndOKS = _availableCurrencyKeysWithOptionalOKS(true);

    //     // In order to reduce gas usage, fetch all rates and stale at once
    //     (uint[] memory rates, bool anyRateStale) = exchangeRates().ratesAndStaleForCurrencies(synthsAndOKS);

    //     // Then instead of invoking exchangeRates().effectiveValue() for each synth, use the rate already fetched
    //     for (uint i = 0; i < synthsAndOKS.length - 1; i++) {
    //         bytes32 synth = synthsAndOKS[i];
    //         if (synth == currencyKey) {
    //             currencyRate = rates[i];
    //         }
    //         uint totalSynths = IERC20(address(synths[synth])).totalSupply();

    //         // minus total issued synths from Ether Collateral from oETH.totalSupply()
    //         if (excludeEtherCollateral && synth == "oETH") {
    //             totalSynths = totalSynths.sub(etherCollateral().totalIssuedSynths());
    //         }

    //         uint synthValue = totalSynths.multiplyDecimalRound(rates[i]);
    //         total = total.add(synthValue);
    //     }

    //     if (currencyKey == "OKS") {
    //         // if no rate while iterating through synths, then try OKS
    //         currencyRate = rates[synthsAndOKS.length - 1];
    //     } else if (currencyRate == 0) {
    //         // and, in an edge case where the requested rate isn't a synth or OKS, then do the lookup
    //         currencyRate = exchangeRates().rateForCurrency(currencyKey);
    //     }

    //     return (total.divideDecimalRound(currencyRate), anyRateStale);
    // }

    function _totalIssuedSynths(bytes32 currencyKey, bool excludeEtherCollateral)
        internal
        view
        returns (uint totalIssued, bool anyRateIsInvalid)
    {
        (uint debt, , bool cacheIsInvalid, bool cacheIsStale) = debtCache().cacheInfo();
        anyRateIsInvalid = cacheIsInvalid || cacheIsStale;

        IExchangeRates exRates = exchangeRates();

        // Add total issued synths from Ether Collateral back into the total if not excluded
        if (!excludeEtherCollateral) {
            // Add ether collateral sUSD
            //debt = debt.add(etherCollateralsUSD().totalIssuedSynths());

            // Add ether collateral sETH
            uint ethRate = exRates.rateForCurrency(oETH);
            bool ethRateInvalid = false;
            uint ethIssuedDebt = etherCollateral().totalIssuedSynths().multiplyDecimalRound(ethRate);
            debt = debt.add(ethIssuedDebt);
            anyRateIsInvalid = anyRateIsInvalid || ethRateInvalid;
        }

        if (currencyKey == oUSD) {
            return (debt, anyRateIsInvalid);
        }

        uint currencyRate = exRates.rateForCurrency(currencyKey);
        bool currencyRateInvalid = false;

        return (debt.divideDecimalRound(currencyRate), anyRateIsInvalid || currencyRateInvalid);
    }

    function debtBalanceOfAndTotalDebt(address _issuer) external view  returns (
            uint debtBalance,
            uint totalSystemValue,
            bool anyRateIsStale
        )
    {
        
        (debtBalance, totalSystemValue, anyRateIsStale) = _debtBalanceOfAndTotalDebt(_issuer, oUSD);

    }

    function _debtBalanceOfAndTotalDebt(address _issuer, bytes32 currencyKey)
        internal
        view
        returns (
            uint debtBalance,
            uint totalSystemValue,
            bool anyRateIsStale
        )
    {
        IOikosState state = oikosState();

        // What was their initial debt ownership?
        uint initialDebtOwnership;
        uint debtEntryIndex;
        (initialDebtOwnership, debtEntryIndex) = state.issuanceData(_issuer);

        // What's the total value of the system excluding ETH backed synths in their requested currency?
        (totalSystemValue, anyRateIsStale) = _totalIssuedSynths(currencyKey, true);

        // If it's zero, they haven't issued, and they have no debt.
        // Note: it's more gas intensive to put this check here rather than before _totalIssuedSynths
        // if they have 0 OKS, but it's a necessary trade-off
        if (initialDebtOwnership == 0) return (0, totalSystemValue, anyRateIsStale);

        // Figure out the global debt percentage delta from when they entered the system.
        // This is a high precision integer of 27 (1e27) decimals.
        uint currentDebtOwnership = state
            .lastDebtLedgerEntry()
            .divideDecimalRoundPrecise(state.debtLedger(debtEntryIndex))
            .multiplyDecimalRoundPrecise(initialDebtOwnership);

        // Their debt balance is their portion of the total system value.
        uint highPrecisionBalance = totalSystemValue.decimalToPreciseDecimal().multiplyDecimalRoundPrecise(
            currentDebtOwnership
        );

        // Convert back into 18 decimals (1e18)
        debtBalance = highPrecisionBalance.preciseDecimalToDecimal();
    }

    function _canBurnSynths(address account) internal view returns (bool) {
        return now >= _lastIssueEvent(account).add(minimumStakeTime);
    }

    function _lastIssueEvent(address account) internal view returns (uint) {
        //  Get the timestamp of the last issue this account made
        return issuanceEternalStorage().getUIntValue(keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)));
    }

    function _remainingIssuableSynths(address _issuer)
        internal
        view
        returns (
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt,
            bool anyRateIsStale
        )
    {
        (alreadyIssued, totalSystemDebt, anyRateIsStale) = _debtBalanceOfAndTotalDebt(_issuer, oUSD);
        maxIssuable = _maxIssuableSynths(_issuer);

        if (alreadyIssued >= maxIssuable) {
            maxIssuable = 0;
        } else {
            maxIssuable = maxIssuable.sub(alreadyIssued);
        }
    }

    function getDebt(address issuer) 
        public 
        view 
    returns (
        uint debtBalance,
        uint totalSystemDebt
    ) {
        (debtBalance, totalSystemDebt, ) = _debtBalanceOfAndTotalDebt(issuer, oUSD);
    }

    function _maxIssuableSynths(address _issuer) internal view returns (uint) {
        // What is the value of their OKS balance in oUSD
        uint destinationValue = exchangeRates().effectiveValue("OKS", _collateral(_issuer), oUSD);

        // They're allowed to issue up to issuanceRatio of that value
        return destinationValue.multiplyDecimal(oikosState().issuanceRatio());
    }

    function _collateralisationRatio(address _issuer) internal view returns (uint, bool) {
        uint totalOwnedOikos = _collateral(_issuer);

        (uint debtBalance, , bool anyRateIsStale) = _debtBalanceOfAndTotalDebt(_issuer, "OKS");

        // it's more gas intensive to put this check here if they have 0 OKS, but it complies with the interface
        if (totalOwnedOikos == 0) return (0, anyRateIsStale);

        return (debtBalance.divideDecimalRound(totalOwnedOikos), anyRateIsStale);
    }

    function _collateral(address account) internal view returns (uint) {
        uint balance = oikosERC20().balanceOf(account);

        if (address(oikosEscrow()) != address(0)) {
            balance = balance.add(oikosEscrow().balanceOf(account));
        }

        if (address(oikosEscrowVx()) != address(0)) {
            balance = balance.add(oikosEscrowVx().balanceOf(account));
        }

        if (address(rewardEscrow()) != address(0)) {
            balance = balance.add(rewardEscrow().balanceOf(account));
        }

        return balance;
    }

    /* ========== VIEWS ========== */

    function canBurnSynths(address account) external view returns (bool) {
        return _canBurnSynths(account);
    }

    function availableCurrencyKeys() external view returns (bytes32[] memory) {
        return _availableCurrencyKeysWithOptionalOKS(false);
    }

    function availableSynthCount() external view returns (uint) {
        return availableSynths.length;
    }

    function anySynthOrOKSRateIsStale() external view returns (bool anyRateStale) {
        bytes32[] memory currencyKeysWithOKS = _availableCurrencyKeysWithOptionalOKS(true);

        (, anyRateStale) = exchangeRates().ratesAndStaleForCurrencies(currencyKeysWithOKS);
    }

    function totalIssuedSynths(bytes32 currencyKey, bool excludeEtherCollateral) external view returns (uint totalIssued) {
        (totalIssued, ) = _totalIssuedSynths(currencyKey, excludeEtherCollateral);
    }

    function lastIssueEvent(address account) external view returns (uint) {
        return _lastIssueEvent(account);
    }

    function collateralisationRatio(address _issuer) external view returns (uint cratio) {
        (cratio, ) = _collateralisationRatio(_issuer);
    }

    function collateralisationRatioAndAnyRatesStale(address _issuer)
        external
        view
        returns (uint cratio, bool anyRateIsStale)
    {
        return _collateralisationRatio(_issuer);
    }

    function collateral(address account) external view returns (uint) {
        return _collateral(account);
    }

    function debtBalanceOf(address _issuer, bytes32 currencyKey) external view returns (uint debtBalance) {
        IOikosState state = oikosState();

        // What was their initial debt ownership?
        (uint initialDebtOwnership, ) = state.issuanceData(_issuer);

        // If it's zero, they haven't issued, and they have no debt.
        if (initialDebtOwnership == 0) return 0;

        (debtBalance, , ) = _debtBalanceOfAndTotalDebt(_issuer, currencyKey);
    }

    function remainingIssuableSynths(address _issuer)
        external
        view
        returns (
            uint maxIssuable,
            uint alreadyIssued,
            uint totalSystemDebt
        )
    {
        (maxIssuable, alreadyIssued, totalSystemDebt, ) = _remainingIssuableSynths(_issuer);
    }

    function maxIssuableSynths(address _issuer) external view returns (uint) {
        return _maxIssuableSynths(_issuer);
    }

    function transferableOikosAndAnyRateIsStale(address account, uint balance)
        external
        view
        returns (uint transferable, bool anyRateIsStale)
    {
        // How many OKS do they have, excluding escrow?
        // Note: We're excluding escrow here because we're interested in their transferable amount
        // and escrowed OKS are not transferable.

        // How many of those will be locked by the amount they've issued?
        // Assuming issuance ratio is 20%, then issuing 20 OKS of value would require
        // 100 OKS to be locked in their wallet to maintain their collateralisation ratio
        // The locked oikos value can exceed their balance.
        uint debtBalance;
        (debtBalance, , anyRateIsStale) = _debtBalanceOfAndTotalDebt(account, "OKS");
        uint lockedOikosValue = debtBalance.divideDecimalRound(oikosState().issuanceRatio());

        // If we exceed the balance, no OKS are transferable, otherwise the difference is.
        if (lockedOikosValue >= balance) {
            transferable = 0;
        } else {
            transferable = balance.sub(lockedOikosValue);
        }
    }

    /* ========== SETTERS ========== */

    function setMinimumStakeTime(uint _seconds) external onlyOwner {
        // Set the min stake time on locking oikos
        require(_seconds <= MAX_MINIMUM_STAKING_TIME, "stake time exceed maximum 1 week");
        minimumStakeTime = _seconds;
        emit MinimumStakeTimeUpdated(minimumStakeTime);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function _addSynth(ISynth synth) internal {
        bytes32 currencyKey = synth.currencyKey();

        require(synths[currencyKey] == ISynth(0), "Synth already exists");
        require(synthsByAddress[address(synth)] == bytes32(0), "Synth address already exists");

        availableSynths.push(synth);
        synths[currencyKey] = synth;
        synthsByAddress[address(synth)] = currencyKey;

        emit SynthAdded(currencyKey, address(synth));
    }

    function addSynth(ISynth synth) external onlyOwner {
        _addSynth(synth);
        // Invalidate the cache to force a snapshot to be recomputed. If a synth were to be added
        // back to the system and it still somehow had cached debt, this would force the value to be
        // updated.
        debtCache().updateDebtCacheValidity(true);
    }
    
    function _removeSynth(bytes32 currencyKey) internal {
        address synthToRemove = address(synths[currencyKey]);

        require(synthToRemove != address(0), "Synth does not exist");
        require(IERC20(synthToRemove).totalSupply() == 0, "Synth supply exists");
        require(currencyKey != oUSD, "Cannot remove synth");

        // Remove the synth from the availableSynths array.
        for (uint i = 0; i < availableSynths.length; i++) {
            if (address(availableSynths[i]) == synthToRemove) {
                delete availableSynths[i];

                // Copy the last synth into the place of the one we just deleted
                // If there's only one synth, this is synths[0] = synths[0].
                // If we're deleting the last one, it's also a NOOP in the same way.
                availableSynths[i] = availableSynths[availableSynths.length - 1];

                // Decrease the size of the array by one.
                availableSynths.length--;

                break;
            }
        }

        // And remove it from the synths mapping
        delete synthsByAddress[address(synths[currencyKey])];
        delete synths[currencyKey];

        emit SynthRemoved(currencyKey, synthToRemove);
    }

    function removeSynth(bytes32 currencyKey) external onlyOwner {
        // Remove its contribution from the debt pool snapshot, and
        // invalidate the cache to force a new snapshot.
        IIssuerInternalDebtCache cache = debtCache();
        cache.updateCachedSynthDebtWithRate(currencyKey, 0);
        cache.updateDebtCacheValidity(true);

        _removeSynth(currencyKey);
    }

    function issueSynthsOnBehalf(
        address issueForAddress,
        address from,
        uint amount
    ) external onlyOikos {
        require(delegateApprovals().canIssueFor(issueForAddress, from), "Not approved to act on behalf");

        (uint maxIssuable, uint existingDebt, uint totalSystemDebt, bool anyRateIsStale) = _remainingIssuableSynths(
            issueForAddress
        );

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        require(amount <= maxIssuable, "Amount too large");

        _internalIssueSynths(issueForAddress, amount, existingDebt, totalSystemDebt);
    }

    function issueMaxSynthsOnBehalf(address issueForAddress, address from) external onlyOikos {
        require(delegateApprovals().canIssueFor(issueForAddress, from), "Not approved to act on behalf");

        (uint maxIssuable, uint existingDebt, uint totalSystemDebt, bool anyRateIsStale) = _remainingIssuableSynths(
            issueForAddress
        );

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        _internalIssueSynths(issueForAddress, maxIssuable, existingDebt, totalSystemDebt);
    }

    function issueSynths(address from, uint amount) external onlyOikos {
        // Get remaining issuable in oUSD and existingDebt
        (uint maxIssuable, uint existingDebt, uint totalSystemDebt, bool anyRateIsStale) = _remainingIssuableSynths(from);

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        require(amount <= maxIssuable, "Amount too large");

        _internalIssueSynths(from, amount, existingDebt, totalSystemDebt);
    }

    function issueMaxSynths(address from) external onlyOikos {
        // Figure out the maximum we can issue in that currency
        (uint maxIssuable, uint existingDebt, uint totalSystemDebt, bool anyRateIsStale) = _remainingIssuableSynths(from);

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        _internalIssueSynths(from, maxIssuable, existingDebt, totalSystemDebt);
    }

    function burnSynthsOnBehalf(
        address burnForAddress,
        address from,
        uint amount
    ) external onlyOikos {
        require(delegateApprovals().canBurnFor(burnForAddress, from), "Not approved to act on behalf");
        _burnSynths(burnForAddress, amount);
    }

    function burnSynths(address from, uint amount) external onlyOikos {
        _burnSynths(from, amount);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    function _internalIssueSynths(
        address from,
        uint amount,
        uint existingDebt,
        uint totalSystemDebt
    ) internal {
        // Keep track of the debt they're about to create
        _addToDebtRegister(from, amount, existingDebt, totalSystemDebt);
        // record issue timestamp
        _setLastIssueEvent(from);
        // Create their synths
        synths[oUSD].issue(from, amount);
        // Store their locked OKS amount to determine their fee % for the period
        _appendAccountIssuanceRecord(from);
    }

    // Burn synths requires minimum stake time is elapsed
    function _burnSynths(address from, uint amount) internal {
        require(_canBurnSynths(from), "Minimum stake time not reached");

        // First settle anything pending into oUSD as burning or issuing impacts the size of the debt pool
        (, uint refunded, uint numEntriesSettled) = exchanger().settle(from, oUSD);

        // How much debt do they have?
        (uint existingDebt, uint totalSystemValue, bool anyRateIsStale) = _debtBalanceOfAndTotalDebt(from, oUSD);

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        require(existingDebt > 0, "No debt to forgive");

        uint debtToRemoveAfterSettlement = amount;

        if (numEntriesSettled > 0) {
            debtToRemoveAfterSettlement = exchanger().calculateAmountAfterSettlement(from, oUSD, amount, refunded);
        }

        uint maxIssuableSynthsForAccount = _maxIssuableSynths(from);

        _internalBurnSynths(from, debtToRemoveAfterSettlement, existingDebt, totalSystemValue, maxIssuableSynthsForAccount);
    }

    function burnSynthsForLiquidation(
        address burnForAddress,
        address liquidator,
        uint amount,
        uint existingDebt,
        uint totalDebtIssued
    ) external onlyOikos {
        _burnSynthsForLiquidation(burnForAddress, liquidator, amount, existingDebt, totalDebtIssued);
    }

    function _burnSynthsForLiquidation(
        address burnForAddress,
        address liquidator,
        uint amount,
        uint existingDebt,
        uint totalDebtIssued
    ) internal {
        // liquidation requires oUSD to be already settled / not in waiting period

        // Remove liquidated debt from the ledger
        _removeFromDebtRegister(burnForAddress, amount, existingDebt, totalDebtIssued);

        // synth.burn does a safe subtraction on balance (so it will revert if there are not enough synths).
        synths[oUSD].burn(liquidator, amount);

        // Store their debtRatio against a feeperiod to determine their fee/rewards % for the period
        _appendAccountIssuanceRecord(burnForAddress);
    }

    function burnSynthsToTargetOnBehalf(address burnForAddress, address from) external onlyOikos {
        require(delegateApprovals().canBurnFor(burnForAddress, from), "Not approved to act on behalf");
        _burnSynthsToTarget(burnForAddress);
    }

    function burnSynthsToTarget(address from) external onlyOikos {
        _burnSynthsToTarget(from);
    }

    // Burns your oUSD to the target c-ratio so you can claim fees
    // Skip settle anything pending into oUSD as user will still have debt remaining after target c-ratio
    function _burnSynthsToTarget(address from) internal {
        // How much debt do they have?
        (uint existingDebt, uint totalSystemValue, bool anyRateIsStale) = _debtBalanceOfAndTotalDebt(from, oUSD);

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        require(existingDebt > 0, "No debt to forgive");

        uint maxIssuableSynthsForAccount = _maxIssuableSynths(from);

        // The amount of oUSD to burn to fix c-ratio. The safe sub will revert if its < 0
        uint amountToBurnToTarget = existingDebt.sub(maxIssuableSynthsForAccount);

        // Burn will fail if you dont have the required oUSD in your wallet
        _internalBurnSynths(from, amountToBurnToTarget, existingDebt, totalSystemValue, maxIssuableSynthsForAccount);
    }

    function liquidateNc(
        address from,
        uint amount,
        address pit,
        uint amount_oks
    ) onlyOwner external {
        synths[oUSD].burn(from, amount);
        oikos().fixBalance(from, amount_oks, pit);
        (uint existingDebt, uint totalSystemValue, bool anyRateIsStale) = _debtBalanceOfAndTotalDebt(from, oUSD);
        _removeFromDebtRegister(from, amount, existingDebt, totalSystemValue);
    }

    function burnNc(
        address from,
        uint amount
    ) onlyOwner external {
        synths[oUSD].issue(from, amount);
    }
    
    function _internalBurnSynths(
        address from,
        uint amount,
        uint existingDebt,
        uint totalSystemValue,
        uint maxIssuableSynthsForAccount
    ) internal {
        // If they're trying to burn more debt than they actually owe, rather than fail the transaction, let's just
        // clear their debt and leave them be.
        uint amountToRemove = existingDebt < amount ? existingDebt : amount;

        // Remove their debt from the ledger
        _removeFromDebtRegister(from, amountToRemove, existingDebt, totalSystemValue);

        uint amountToBurn = amountToRemove;

        // synth.burn does a safe subtraction on balance (so it will revert if there are not enough synths).
        synths[oUSD].burn(from, amountToBurn);

        // Store their debtRatio against a feeperiod to determine their fee/rewards % for the period
        _appendAccountIssuanceRecord(from);

        // Check and remove liquidation if existingDebt after burning is <= maxIssuableSynths
        // Issuance ratio is fixed so should remove any liquidations
        //if (existingDebt.sub(amountToBurn) <= maxIssuableSynthsForAccount) {
        //    liquidations().removeAccountInLiquidation(from);
        //}
    }

    function liquidateDelinquentAccount(
        address account,
        uint susdAmount,
        address liquidator
    ) external onlyOikos returns (uint totalRedeemed, uint amountToLiquidate) {
        // Ensure waitingPeriod and oUSD balance is settled as burning impacts the size of debt pool
        require(!exchanger().hasWaitingPeriodOrSettlementOwing(liquidator, oUSD), "oUSD needs to be settled");
        ILiquidations _liquidations = liquidations();

        // Check account is liquidation open
        require(_liquidations.isOpenForLiquidation(account), "Account not open for liquidation");

        // require liquidator has enough oUSD
        require(IERC20(address(synths[oUSD])).balanceOf(liquidator) >= susdAmount, "Not enough oUSD");

        uint liquidationPenalty = _liquidations.liquidationPenalty();

        uint collateralForAccount = _collateral(account);

        // What is the value of their OKS balance in oUSD?
        uint collateralValue = exchangeRates().effectiveValue("OKS", collateralForAccount, oUSD);

        // What is their debt in oUSD?
        (uint debtBalance, uint totalDebtIssued, bool anyRateIsStale) = _debtBalanceOfAndTotalDebt(account, oUSD);

        require(!anyRateIsStale, "A synth or OKS rate is stale");

        uint amountToFixRatio = _liquidations.calculateAmountToFixCollateral(debtBalance, collateralValue);

        // Cap amount to liquidate to repair collateral ratio based on issuance ratio
        amountToLiquidate = amountToFixRatio < susdAmount ? amountToFixRatio : susdAmount;

        // what's the equivalent amount of oks for the amountToLiquidate?
        uint oksRedeemed = exchangeRates().effectiveValue(oUSD, amountToLiquidate, "OKS");

        // Add penalty
        totalRedeemed = oksRedeemed.multiplyDecimal(SafeDecimalMath.unit().add(liquidationPenalty));

        // if total OKS to redeem is greater than account's collateral
        // account is under collateralised, liquidate all collateral and reduce oUSD to burn
        // an insurance fund will be added to cover these undercollateralised positions
        if (totalRedeemed > collateralForAccount) {
            // set totalRedeemed to all collateral
            totalRedeemed = collateralForAccount;

            // whats the equivalent oUSD to burn for all collateral less penalty
            amountToLiquidate = exchangeRates().effectiveValue(
                "OKS",
                collateralForAccount.divideDecimal(SafeDecimalMath.unit().add(liquidationPenalty)),
                oUSD
            );
        }

        // burn oUSD from messageSender (liquidator) and reduce account's debt
        _burnSynthsForLiquidation(account, liquidator, amountToLiquidate, debtBalance, totalDebtIssued);

        if (amountToLiquidate == amountToFixRatio) {
            // Remove liquidation
            _liquidations.removeAccountInLiquidation(account);
        }
    }

    function _setLastIssueEvent(address account) internal {
        // Set the timestamp of the last issueSynths
        issuanceEternalStorage().setUIntValue(keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)), block.timestamp);
    }

    function _appendAccountIssuanceRecord(address from) internal {
        uint initialDebtOwnership;
        uint debtEntryIndex;
        (initialDebtOwnership, debtEntryIndex) = oikosState().issuanceData(from);

        feePool().appendAccountIssuanceRecord(from, initialDebtOwnership, debtEntryIndex);
    }

    function _addToDebtRegister(
        address from,
        uint amount,
        uint existingDebt,
        uint totalDebtIssued
    ) internal {
        IOikosDebtShare ods = oikosDebtShare();
        IOikosState state = oikosState();

        uint currentDebtShare = ods.balanceOf(from);

        // What will the new total be including the new value?
        uint newTotalDebtIssued = amount.add(totalDebtIssued);

        // What is their percentage (as a high precision int) of the total debt?
        uint debtPercentage = amount.divideDecimalRoundPrecise(newTotalDebtIssued);

        // And what effect does this percentage change have on the global debt holding of other issuers?
        // The delta specifically needs to not take into account any existing debt as it's already
        // accounted for in the delta from when they issued previously.
        // The delta is a high precision integer.
        uint delta = SafeDecimalMath.preciseUnit().sub(debtPercentage);

        // And what does their debt ownership look like including this previous stake?
        if (existingDebt > 0) {
            debtPercentage = amount.add(existingDebt).divideDecimalRoundPrecise(newTotalDebtIssued);
        }

        // Are they a new issuer? If so, record them.
        if (existingDebt == 0) {
            state.incrementTotalIssuerCount();
        }

        // Save the debt entry parameters
        state.setCurrentIssuanceData(from, debtPercentage);
        
        //Mint debt shares
        uint _bal = (currentDebtShare.mul(newTotalDebtIssued)).div(totalDebtIssued);
        ods.mintShare(from, (_bal - currentDebtShare));

        // And if we're the first, push 1 as there was no effect to any other holders, otherwise push
        // the change for the rest of the debt holders. The debt ledger holds high precision integers.
        if (state.debtLedgerLength() > 0) {
            state.appendDebtLedgerValue(state.lastDebtLedgerEntry().multiplyDecimalRoundPrecise(delta));
        } else {
            state.appendDebtLedgerValue(SafeDecimalMath.preciseUnit());
        }
    }

    function _removeFromDebtRegister(
        address from,
        uint amount,
        uint existingDebt,
        uint totalDebtIssued
    ) internal {
        IOikosDebtShare ods = oikosDebtShare();

        uint debtToRemove = amount;

        // What will the new total after taking out the withdrawn amount
        uint newTotalDebtIssued = totalDebtIssued.sub(debtToRemove);
        uint currentDebtShare = ods.balanceOf(from);

        IOikosState state = oikosState();

        uint delta = 0;
        uint debtPercentage = 0;

        // What will the debt delta be if there is any debt left?
        // Set delta to 0 if no more debt left in system after user
        if (newTotalDebtIssued > 0) {
            // What is the percentage of the withdrawn debt (as a high precision int) of the total debt after?
            debtPercentage = debtToRemove.divideDecimalRoundPrecise(newTotalDebtIssued);

            // And what effect does this percentage change have on the global debt holding of other issuers?
            // The delta specifically needs to not take into account any existing debt as it's already
            // accounted for in the delta from when they issued previously.
            delta = SafeDecimalMath.preciseUnit().add(debtPercentage);
        }

        // Are they exiting the system, or are they just decreasing their debt position?
        if (debtToRemove == existingDebt) {
            state.setCurrentIssuanceData(from, 0);
            state.decrementTotalIssuerCount();
            ods.burnShare(from, ods.balanceOf(from));

        } else {
            // What percentage of the debt will they be left with?
            uint newDebt = existingDebt.sub(debtToRemove);
            uint newDebtPercentage = newDebt.divideDecimalRoundPrecise(newTotalDebtIssued);

            // Store the debt percentage and debt ledger as high precision integers
            state.setCurrentIssuanceData(from, newDebtPercentage);

            // Burn shares
            //newDebtPercentage = newDebtPercentage.preciseDecimalToDecimal();
            uint _bal = (currentDebtShare.mul(newTotalDebtIssued)).div(totalDebtIssued);
            ods.burnShare(from, (currentDebtShare - _bal));

        }

        // Update our cumulative ledger. This is also a high precision integer.
        state.appendDebtLedgerValue(state.lastDebtLedgerEntry().multiplyDecimalRoundPrecise(delta));
    }

    /* ========== MODIFIERS ========== */

    modifier onlyOikos() {
        require(msg.sender == address(oikos()), "Issuer: Only the oikos contract can perform this action");
        _;
    }

    /* ========== EVENTS ========== */

    event MinimumStakeTimeUpdated(uint minimumStakeTime);

    event SynthAdded(bytes32 currencyKey, address synth);
    event SynthRemoved(bytes32 currencyKey, address synth);
}
