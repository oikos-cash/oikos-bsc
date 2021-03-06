pragma solidity 0.4.25;

import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "./SafeDecimalMath.sol";
import "./MixinResolver.sol";
import "./IssuanceEternalStorage.sol";
import "./interfaces/IOikos.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/IOikosState.sol";
import "./interfaces/IExchanger.sol";


contract Issuer is MixinResolver {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 private constant oUSD = "oUSD";
    bytes32 public constant LAST_ISSUE_EVENT = "LAST_ISSUE_EVENT";

    // Minimum Stake time may not exceed 1 weeks.
    uint public constant MAX_MINIMUM_STAKING_TIME = 1 weeks;

    uint public minimumStakeTime = 8 hours; // default minimum waiting period after issuing synths 
    
    constructor(address _owner, address _resolver) public MixinResolver(_owner, _resolver) {}

    /* ========== VIEWS ========== */
    function oikos() internal view returns (IOikos) {
        return IOikos(resolver.requireAndGetAddress("Oikos", "Missing Oikos address"));
    }

    function exchanger() internal view returns (IExchanger) {
        return IExchanger(resolver.requireAndGetAddress("Exchanger", "Missing Exchanger address"));
    }

    function oikosState() internal view returns (IOikosState) {
        return IOikosState(resolver.requireAndGetAddress("OikosState", "Missing OikosState address"));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(resolver.requireAndGetAddress("FeePool", "Missing FeePool address"));
    }

    function issuanceEternalStorage() internal view returns (IssuanceEternalStorage) {
        return IssuanceEternalStorage(resolver.requireAndGetAddress("IssuanceEternalStorage", "Missing IssuanceEternalStorage address"));
    }

    /* ========== VIEWS ========== */

    function canBurnSynths(address account) public view returns (bool) {
        return now >= lastIssueEvent(account).add(minimumStakeTime);
    }

    /**
     * @notice Get the timestamp of the last issue this account made
     * @param account account to check the last issue this account made
     * @return timestamp this account last issued synths
     */
    function lastIssueEvent(address account) public view returns (uint) {
        return issuanceEternalStorage().getUIntValue(keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)));
    }
    
    /* ========== SETTERS ========== */

    /**
     * @notice Set the min stake time on locking oikos
     * @param _seconds The new minimumStakeTime
     */
    function setMinimumStakeTime(uint _seconds) external onlyOwner {
        require(_seconds <= MAX_MINIMUM_STAKING_TIME, "stake time exceed maximum 1 week");
        minimumStakeTime = _seconds;
        emit MinimumStakeTimeUpdated(minimumStakeTime);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */
    /**
     * @notice Set the timestamp of the last issueSynths 
     * @param account account to set the last issue for
     */
    function _setLastIssueEvent(address account) internal {
        issuanceEternalStorage().setUIntValue(
            keccak256(abi.encodePacked(LAST_ISSUE_EVENT, account)),
            block.timestamp
        );
    }    
    
    function issueSynths(address from, uint amount)
        external
        onlyOikos
    // No need to check if price is stale, as it is checked in issuableSynths.
    {
        // Get remaining issuable in oUSD and existingDebt
        (uint maxIssuable, uint existingDebt, uint totalSystemDebt) = oikos().remainingIssuableSynths(from);
        require(amount <= maxIssuable, "Amount too large");

        _internalIssueSynths(from, amount, existingDebt, totalSystemDebt);
    }

    function issueMaxSynths(address from) external onlyOikos {
        // Figure out the maximum we can issue in that currency
        (uint maxIssuable, uint existingDebt, uint totalSystemDebt) = oikos().remainingIssuableSynths(from);

        _internalIssueSynths(from, maxIssuable, existingDebt, totalSystemDebt);
    }

    function _internalIssueSynths(address from, uint amount, uint existingDebt, uint totalSystemDebt)
        internal
    {
        // Keep track of the debt they're about to create
        _addToDebtRegister(from, amount, existingDebt, totalSystemDebt);

        // record issue timestamp
        _setLastIssueEvent(from);

        // Create their synths
        oikos().synths(oUSD).issue(from, amount);

        // Store their locked OKS amount to determine their fee % for the period
        _appendAccountIssuanceRecord(from);
    }

    // Burn synths requires minimum stake time is elapsed
    function burnSynths(address from, uint amount)
        external
        onlyOikos
    {
        require(canBurnSynths(from), "Minimum stake time not reached");

        // First settle anything pending into oUSD as burning or issuing impacts the size of the debt pool
        (, uint refunded) = exchanger().settle(from, oUSD);

        // How much debt do they have?
        (uint existingDebt, uint totalSystemValue) = oikos().debtBalanceOfAndTotalDebt(from, oUSD);

        require(existingDebt > 0, "No debt to forgive");

        uint debtToRemoveAfterSettlement = exchanger().calculateAmountAfterSettlement(from, oUSD, amount, refunded);

        _internalBurnSynths(from, debtToRemoveAfterSettlement, existingDebt, totalSystemValue);
    }

    // Burns your oUSD to the target c-ratio so you can claim fees
    // Skip settle anything pending into oUSD as user will still have debt remaining after target c-ratio 
    function burnSynthsToTarget(address from)
        external
        onlyOikos
    {
        // How much debt do they have?
        (uint existingDebt, uint totalSystemValue) = oikos().debtBalanceOfAndTotalDebt(from, oUSD);

        require(existingDebt > 0, "No debt to forgive");

        // The maximum amount issuable against their total OKS balance.
        uint maxIssuable = oikos().maxIssuableSynths(from);

        // The amount of oUSD to burn to fix c-ratio. The safe sub will revert if its < 0
        uint amountToBurnToTarget = existingDebt.sub(maxIssuable);

        // Burn will fail if you dont have the required oUSD in your wallet
        _internalBurnSynths(from, amountToBurnToTarget, existingDebt, totalSystemValue);
    }

    function _internalBurnSynths(address from, uint amount, uint existingDebt, uint totalSystemValue)
        internal
        // No need to check for stale rates as effectiveValue checks rates
    {
        // If they're trying to burn more debt than they actually owe, rather than fail the transaction, let's just
        // clear their debt and leave them be.
        uint amountToRemove = existingDebt < amount ? existingDebt : amount;

        // Remove their debt from the ledger
        _removeFromDebtRegister(from, amountToRemove, existingDebt, totalSystemValue);

        uint amountToBurn = amountToRemove;

        // synth.burn does a safe subtraction on balance (so it will revert if there are not enough synths).
        oikos().synths(oUSD).burn(from, amountToBurn);

        // Store their debtRatio against a feeperiod to determine their fee/rewards % for the period
        _appendAccountIssuanceRecord(from);
    }

    /* ========== INTERNAL FUNCTIONS ========== */

    /**
     * @notice Store in the FeePool the users current debt value in the system.
      * @dev debtBalanceOf(messageSender, "oUSD") to be used with totalIssuedSynthsExcludeBNBCollateral("oUSD") to get
     *  users % of the system within a feePeriod.
     */
    function _appendAccountIssuanceRecord(address from) internal {
        uint initialDebtOwnership;
        uint debtEntryIndex;
        (initialDebtOwnership, debtEntryIndex) = oikosState().issuanceData(from);

        feePool().appendAccountIssuanceRecord(from, initialDebtOwnership, debtEntryIndex);
    }

    /**
     * @notice Function that registers new synth as they are issued. Calculate delta to append to oikosState.
     * @dev Only internal calls from oikos address.
     * @param amount The amount of synths to register with a base of UNIT
     */
    function _addToDebtRegister(address from, uint amount, uint existingDebt, uint totalDebtIssued) internal {
        IOikosState state = oikosState();

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

        // And if we're the first, push 1 as there was no effect to any other holders, otherwise push
        // the change for the rest of the debt holders. The debt ledger holds high precision integers.
        if (state.debtLedgerLength() > 0) {
            state.appendDebtLedgerValue(state.lastDebtLedgerEntry().multiplyDecimalRoundPrecise(delta));
        } else {
            state.appendDebtLedgerValue(SafeDecimalMath.preciseUnit());
        }
    }

    /**
     * @notice Remove a debt position from the register
     * @param amount The amount (in UNIT base) being presented in sUSDs
     * @param existingDebt The existing debt (in UNIT base) of address presented in sUSDs
     * @param totalDebtIssued The existing system debt (in UNIT base) presented in sUSDs
     */
    function _removeFromDebtRegister(address from, uint amount, uint existingDebt, uint totalDebtIssued) internal {
        IOikosState state = oikosState();

        uint debtToRemove = amount;

        // What will the new total after taking out the withdrawn amount
        uint newTotalDebtIssued = totalDebtIssued.sub(debtToRemove);

        uint delta = 0;

        // What will the debt delta be if there is any debt left?
        // Set delta to 0 if no more debt left in system after user
        if (newTotalDebtIssued > 0) {
            // What is the percentage of the withdrawn debt (as a high precision int) of the total debt after?
            uint debtPercentage = debtToRemove.divideDecimalRoundPrecise(newTotalDebtIssued);

            // And what effect does this percentage change have on the global debt holding of other issuers?
            // The delta specifically needs to not take into account any existing debt as it's already
            // accounted for in the delta from when they issued previously.
            delta = SafeDecimalMath.preciseUnit().add(debtPercentage);
        }

        // Are they exiting the system, or are they just decreasing their debt position?
        if (debtToRemove == existingDebt) {
            state.setCurrentIssuanceData(from, 0);
            state.decrementTotalIssuerCount();
        } else {
            // What percentage of the debt will they be left with?
            uint newDebt = existingDebt.sub(debtToRemove);
            uint newDebtPercentage = newDebt.divideDecimalRoundPrecise(newTotalDebtIssued);

            // Store the debt percentage and debt ledger as high precision integers
            state.setCurrentIssuanceData(from, newDebtPercentage);
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
}
