pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./MixinResolver.sol";
import "./interfaces/IExchanger.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/IERC20.sol";
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IExchangeState.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IOikos.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IDelegateApprovals.sol";
import "./interfaces/IIssuer.sol";


// Used to have strongly-typed access to internal mutative functions in Oikos
interface IOikosInternal {
    function emitSynthExchange(
        address account,
        bytes32 fromCurrencyKey,
        uint fromAmount,
        bytes32 toCurrencyKey,
        uint toAmount,
        address toAddress
    ) external;

    function emitExchangeReclaim(
        address account,
        bytes32 currencyKey,
        uint amount
    ) external;

    function emitExchangeRebate(
        address account,
        bytes32 currencyKey,
        uint amount
    ) external;
}


// https://docs.oikos.cash/contracts/Exchanger
contract Exchanger is Owned, MixinResolver, IExchanger {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 private constant oUSD = "oUSD";

    uint public waitingPeriodSecs;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_EXCHANGESTATE = "ExchangeState";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_OIKOS = "Oikos";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_DELEGATEAPPROVALS = "DelegateApprovals";
    bytes32 private constant CONTRACT_ISSUER = "Issuer";

    bytes32[24] private addressesToCache = [
        CONTRACT_SYSTEMSTATUS,
        CONTRACT_EXCHANGESTATE,
        CONTRACT_EXRATES,
        CONTRACT_OIKOS,
        CONTRACT_FEEPOOL,
        CONTRACT_DELEGATEAPPROVALS,
        CONTRACT_ISSUER
    ];

    constructor(address _owner, address _resolver) public Owned(_owner) MixinResolver(_resolver, addressesToCache) {
        waitingPeriodSecs = 6 minutes;
    }

    /* ========== VIEWS ========== */

    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(resolver.requireAndGetAddress("SystemStatus", "Missing SystemStatus address"));
    }

    function exchangeState() internal view returns (IExchangeState) {
        return IExchangeState(resolver.requireAndGetAddress("ExchangeState", "Missing ExchangeState address"));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(resolver.requireAndGetAddress("ExchangeRates", "Missing ExchangeRates address"));
    }

    function oikos() internal view returns (IOikos) {
        return IOikos(resolver.requireAndGetAddress("Oikos", "Missing Oikos address"));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(resolver.requireAndGetAddress("FeePool", "Missing FeePool address"));
    }

    function delegateApprovals() internal view returns (IDelegateApprovals) {
        return IDelegateApprovals(resolver.requireAndGetAddress("DelegateApprovals", "Missing DelegateApprovals address"));
    }

    function issuer() internal view returns (IIssuer) {
        return IIssuer(resolver.requireAndGetAddress("Issuer", "Missing Issuer address"));
    }

    function maxSecsLeftInWaitingPeriod(address account, bytes32 currencyKey) public view returns (uint) {
        return secsLeftInWaitingPeriodForExchange(exchangeState().getMaxTimestamp(account, currencyKey));
    }

    function settlementOwing(address account, bytes32 currencyKey)
        public
        view
        returns (
            uint reclaimAmount,
            uint rebateAmount,
            uint numEntries
        )
    {
        // Need to sum up all reclaim and rebate amounts for the user and the currency key
        numEntries = exchangeState().getLengthOfEntries(account, currencyKey);

        // For each unsettled exchange
        for (uint i = 0; i < numEntries; i++) {
            // fetch the entry from storage
            (bytes32 src, uint amount, bytes32 dest, uint amountReceived, uint exchangeFeeRate, , , ) = exchangeState()
                .getEntryAt(account, currencyKey, i);

            // determine the last round ids for src and dest pairs when period ended or latest if not over
            (uint srcRoundIdAtPeriodEnd, uint destRoundIdAtPeriodEnd) = getRoundIdsAtPeriodEnd(account, currencyKey, i);

            // given these round ids, determine what effective value they should have received
            uint destinationAmount = exchangeRates().effectiveValueAtRound(
                src,
                amount,
                dest,
                srcRoundIdAtPeriodEnd,
                destRoundIdAtPeriodEnd
            );

            // and deduct the fee from this amount using the exchangeFeeRate from storage
            uint amountShouldHaveReceived = _getAmountReceivedForExchange(destinationAmount, exchangeFeeRate);

            if (amountReceived > amountShouldHaveReceived) {
                // if they received more than they should have, add to the reclaim tally
                reclaimAmount = reclaimAmount.add(amountReceived.sub(amountShouldHaveReceived));
            } else if (amountShouldHaveReceived > amountReceived) {
                // if less, add to the rebate tally
                rebateAmount = rebateAmount.add(amountShouldHaveReceived.sub(amountReceived));
            }
        }

        return (reclaimAmount, rebateAmount, numEntries);
    }

    function hasWaitingPeriodOrSettlementOwing(address account, bytes32 currencyKey) external view returns (bool) {
        if (maxSecsLeftInWaitingPeriod(account, currencyKey) != 0) {
            return true;
        }

        (uint reclaimAmount, , ) = settlementOwing(account, currencyKey);

        return reclaimAmount > 0;
    }

    /* ========== SETTERS ========== */

    function setWaitingPeriodSecs(uint _waitingPeriodSecs) external onlyOwner {
        waitingPeriodSecs = _waitingPeriodSecs;
    }

    function calculateAmountAfterSettlement(
        address from,
        bytes32 currencyKey,
        uint amount,
        uint refunded
    ) public view returns (uint amountAfterSettlement) {
        amountAfterSettlement = amount;

        // balance of a synth will show an amount after settlement
        uint balanceOfSourceAfterSettlement = IERC20(address(issuer().synths(currencyKey))).balanceOf(from);

        // when there isn't enough supply (either due to reclamation settlement or because the number is too high)
        if (amountAfterSettlement > balanceOfSourceAfterSettlement) {
            // then the amount to exchange is reduced to their remaining supply
            amountAfterSettlement = balanceOfSourceAfterSettlement;
        }

        if (refunded > 0) {
            amountAfterSettlement = amountAfterSettlement.add(refunded);
        }
    }

    /* ========== MUTATIVE FUNCTIONS ========== */
    function exchange(
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address destinationAddress
    ) external /*onlyOikosorSynth*/ returns (uint amountReceived) {
        amountReceived = _exchange(from, sourceCurrencyKey, sourceAmount, destinationCurrencyKey, destinationAddress);
    }

    function exchangeOnBehalf(
        address exchangeForAddress,
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey
    ) external onlyOikosorSynth returns (uint amountReceived) {
        require(delegateApprovals().canExchangeFor(exchangeForAddress, from), "Not approved to act on behalf");
        amountReceived = _exchange(
            exchangeForAddress,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            exchangeForAddress
        );
    }

    function _exchange(
        address from,
        bytes32 sourceCurrencyKey,
        uint sourceAmount,
        bytes32 destinationCurrencyKey,
        address destinationAddress
    ) internal returns (uint amountReceived) {
        require(sourceCurrencyKey != destinationCurrencyKey, "Can't be same synth");
        require(sourceAmount > 0, "Zero amount");

        bytes32[] memory synthKeys = new bytes32[](2);
        synthKeys[0] = sourceCurrencyKey;
        synthKeys[1] = destinationCurrencyKey;
        require(!exchangeRates().anyRateIsStale(synthKeys), "Src/dest rate stale or not found");

        (, uint refunded, uint numEntriesSettled) = _internalSettle(from, sourceCurrencyKey);

        uint sourceAmountAfterSettlement = sourceAmount;

        // when settlement was required
        if (numEntriesSettled > 0) {
            // ensure the sourceAmount takes this into account
            sourceAmountAfterSettlement = calculateAmountAfterSettlement(from, sourceCurrencyKey, sourceAmount, refunded);

            // If, after settlement the user has no balance left (highly unlikely), then return to prevent
            // emitting events of 0 and don't revert so as to ensure the settlement queue is emptied
            if (sourceAmountAfterSettlement == 0) {
                return 0;
            }
        }

        // Note: We don't need to check their balance as the burn() below will do a safe subtraction which requires
        // the subtraction to not overflow, which would happen if their balance is not sufficient.

        // Burn the source amount
        issuer().synths(sourceCurrencyKey).burn(from, sourceAmount);

        uint fee;
        uint exchangeFeeRate;

        (amountReceived, fee, exchangeFeeRate) = _getAmountsForExchangeMinusFees(
            sourceAmount,
            sourceCurrencyKey,
            destinationCurrencyKey
        );
    
        // Issue their new synths
        issuer().synths(destinationCurrencyKey).issue(destinationAddress, amountReceived);

        // Remit the fee if required
        if (fee > 0) {
            remitFee(fee, destinationCurrencyKey);
        }

        // Nothing changes as far as issuance data goes because the total value in the system hasn't changed.

        // Let the DApps know there was a Synth exchange
        IOikosInternal(address(oikos())).emitSynthExchange(
            from,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            amountReceived,
            destinationAddress
        );

        // persist the exchange information for the dest key
        appendExchange(
            destinationAddress,
            sourceCurrencyKey,
            sourceAmount,
            destinationCurrencyKey,
            amountReceived,
            exchangeFeeRate
        );
    }

    // Note: this function can intentionally be called by anyone on behalf of anyone else (the caller just pays the gas)
    function settle(address from, bytes32 currencyKey)
        external
        synthActive(currencyKey)
        returns (
            uint reclaimed,
            uint refunded,
            uint numEntriesSettled
        )
    {
        return _internalSettle(from, currencyKey);
    }

    /* ========== INTERNAL FUNCTIONS ========== */
    function remitFee(uint fee, bytes32 currencyKey) internal {
        // Remit the fee in oUSDs
        uint usdFeeAmount = exchangeRates().effectiveValue(currencyKey, fee, oUSD);
        issuer().synths(oUSD).issue(feePool().FEE_ADDRESS(), usdFeeAmount);
        // Tell the fee pool about this.
        feePool().recordFeePaid(usdFeeAmount);
    }

    function _internalSettle(address from, bytes32 currencyKey)
        internal
        returns (
            uint reclaimed,
            uint refunded,
            uint numEntriesSettled
        )
    {
        require(maxSecsLeftInWaitingPeriod(from, currencyKey) == 0, "Cannot settle during waiting period");

        (uint reclaimAmount, uint rebateAmount, uint entries) = settlementOwing(from, currencyKey);

        if (reclaimAmount > rebateAmount) {
            reclaimed = reclaimAmount.sub(rebateAmount);
            reclaim(from, currencyKey, reclaimed);
        } else if (rebateAmount > reclaimAmount) {
            refunded = rebateAmount.sub(reclaimAmount);
            refund(from, currencyKey, refunded);
        }

        numEntriesSettled = entries;

        // Now remove all entries, even if no reclaim and no rebate
        exchangeState().removeEntries(from, currencyKey);
    }

    function reclaim(
        address from,
        bytes32 currencyKey,
        uint amount
    ) internal {
        // burn amount from user
        issuer().synths(currencyKey).burn(from, amount);
        IOikosInternal(address(oikos())).emitExchangeReclaim(from, currencyKey, amount);
    }

    function refund(
        address from,
        bytes32 currencyKey,
        uint amount
    ) internal {
        // issue amount to user
        issuer().synths(currencyKey).issue(from, amount);
        IOikosInternal(address(oikos())).emitExchangeRebate(from, currencyKey, amount);
    }

    function secsLeftInWaitingPeriodForExchange(uint timestamp) internal view returns (uint) {
        if (timestamp == 0 || now >= timestamp.add(waitingPeriodSecs)) {
            return 0;
        }

        return timestamp.add(waitingPeriodSecs).sub(now);
    }

    function feeRateForExchange(bytes32 sourceCurrencyKey, bytes32 destinationCurrencyKey)
        external
        view
        returns (uint exchangeFeeRate)
    {
        exchangeFeeRate = _feeRateForExchange(sourceCurrencyKey, destinationCurrencyKey);
    }

    function _feeRateForExchange(
        bytes32, // API for source in case pricing model evolves to include source rate /* sourceCurrencyKey */
        bytes32 destinationCurrencyKey
    ) internal view returns (uint exchangeFeeRate) {
        exchangeFeeRate = feePool().getExchangeFeeRateForSynth(destinationCurrencyKey);
    }

    function getAmountsForExchange(
        uint sourceAmount,
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey
    )
        external
        view
        returns (
            uint amountReceived,
            uint fee,
            uint exchangeFeeRate
        )
    {
        (amountReceived, fee, exchangeFeeRate) = _getAmountsForExchangeMinusFees(
            sourceAmount,
            sourceCurrencyKey,
            destinationCurrencyKey
        );
    }

    function getPrice(bytes32 sourceCurrencyKey, uint sourceAmount, bytes32 destinationCurrencyKey) public view returns (uint) {
        return exchangeRates().effectiveValue(sourceCurrencyKey, sourceAmount, destinationCurrencyKey);
    }

    function _getAmountsForExchangeMinusFees(
        uint sourceAmount,
        bytes32 sourceCurrencyKey,
        bytes32 destinationCurrencyKey
    )
        internal
        view
        returns (
            uint amountReceived,
            uint fee,
            uint exchangeFeeRate
        )
    {
        uint destinationAmount = getPrice(sourceCurrencyKey, sourceAmount, destinationCurrencyKey);
        exchangeFeeRate = _feeRateForExchange(sourceCurrencyKey, destinationCurrencyKey);
        amountReceived = _getAmountReceivedForExchange(destinationAmount, exchangeFeeRate);
        fee = destinationAmount.sub(amountReceived);
    }

    function _getAmountReceivedForExchange(uint destinationAmount, uint exchangeFeeRate)
        internal
        pure
        returns (uint amountReceived)
    {
        amountReceived = destinationAmount.multiplyDecimal(SafeDecimalMath.unit().sub(exchangeFeeRate));
    }

    function appendExchange(
        address account,
        bytes32 src,
        uint amount,
        bytes32 dest,
        uint amountReceived,
        uint exchangeFeeRate
    ) internal {
        IExchangeRates exRates = exchangeRates();
        uint roundIdForSrc = exRates.getCurrentRoundId(src);
        uint roundIdForDest = exRates.getCurrentRoundId(dest);
        exchangeState().appendExchangeEntry(
            account,
            src,
            amount,
            dest,
            amountReceived,
            exchangeFeeRate,
            now,
            roundIdForSrc,
            roundIdForDest
        );
    }

    function getRoundIdsAtPeriodEnd(
        address account,
        bytes32 currencyKey,
        uint index
    ) internal view returns (uint srcRoundIdAtPeriodEnd, uint destRoundIdAtPeriodEnd) {
        (bytes32 src, , bytes32 dest, , , uint timestamp, uint roundIdForSrc, uint roundIdForDest) = exchangeState()
            .getEntryAt(account, currencyKey, index);

        IExchangeRates exRates = exchangeRates();
        srcRoundIdAtPeriodEnd = exRates.getLastRoundIdBeforeElapsedSecs(src, roundIdForSrc, timestamp, waitingPeriodSecs);
        destRoundIdAtPeriodEnd = exRates.getLastRoundIdBeforeElapsedSecs(dest, roundIdForDest, timestamp, waitingPeriodSecs);
    }

    // ========== MODIFIERS ==========

    modifier onlyOikosorSynth() {
        IOikos _oikos = oikos();
        require(
            msg.sender == address(_oikos) || _oikos.synthsByAddress(msg.sender) != bytes32(0),
            "Exchanger: Only oikos or a synth contract can perform this action"
        );
        _;
    }

    modifier synthActive(bytes32 currencyKey) {
        systemStatus().requireExchangeActive();

        systemStatus().requireSynthActive(currencyKey);
        _;
    }
}
