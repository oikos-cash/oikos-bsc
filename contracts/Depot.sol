pragma solidity 0.4.25;

import "openzeppelin-solidity/contracts/utils/ReentrancyGuard.sol";
import "./SelfDestructible.sol";
import "./Pausable.sol";
import "./SafeDecimalMath.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IExchangeRates.sol";
import "./MixinResolver.sol";


contract Depot is SelfDestructible, Pausable, ReentrancyGuard, MixinResolver {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    bytes32 constant OKS = "OKS";
    bytes32 constant BNB = "oBNB";

    /* ========== STATE VARIABLES ========== */

    // Address where the Ether and Synths raised for selling OKS is transfered to
    // Any Ether raised for selling Synths gets sent back to whoever deposited the Synths,
    // and doesn't have anything to do with this address.
    address public fundsWallet;

    /* Stores deposits from users. */
    struct synthDeposit {
        // The user that made the deposit
        address user;
        // The amount (in Synths) that they deposited
        uint amount;
    }

    /* User deposits are sold on a FIFO (First in First out) basis. When users deposit
       synths with us, they get added this queue, which then gets fulfilled in order.
       Conceptually this fits well in an array, but then when users fill an order we
       end up copying the whole array around, so better to use an index mapping instead
       for gas performance reasons.

       The indexes are specified (inclusive, exclusive), so (0, 0) means there's nothing
       in the array, and (3, 6) means there are 3 elements at 3, 4, and 5. You can obtain
       the length of the "array" by querying depositEndIndex - depositStartIndex. All index
       operations use safeAdd, so there is no way to overflow, so that means there is a
       very large but finite amount of deposits this contract can handle before it fills up. */
    mapping(uint => synthDeposit) public deposits;
    // The starting index of our queue inclusive
    uint public depositStartIndex;
    // The ending index of our queue exclusive
    uint public depositEndIndex;

    /* This is a convenience variable so users and dApps can just query how much oUSD
       we have available for purchase without having to iterate the mapping with a
       O(n) amount of calls for somBNBing we'll probably want to display quite regularly. */
    uint public totalSellableDeposits;

    // The minimum amount of oUSD required to enter the FiFo queue
    uint public minimumDepositAmount = 50 * SafeDecimalMath.unit();

    // A cap on the amount of oUSD you can buy with BNB in 1 transaction
    uint public maxBNBPurchase = 500 * SafeDecimalMath.unit();

    // If a user deposits a synth amount < the minimumDepositAmount the contract will keep
    // the total of small deposits which will not be sold on market and the sender
    // must call withdrawMyDepositedSynths() to get them back.
    mapping(address => uint) public smallDeposits;

    /* ========== CONSTRUCTOR ========== */

    constructor(
        // Ownable
        address _owner,
        // Funds Wallet
        address _fundsWallet,
        // Address Resolver
        address _resolver
    )
        public
        /* Owned is initialised in SelfDestructible */
        SelfDestructible(_owner)
        Pausable(_owner)
        MixinResolver(_owner, _resolver)
    {
        fundsWallet = _fundsWallet;
    }

    /* ========== SETTERS ========== */

    function setMaxBNBPurchase(uint _maxBNBPurchase) external onlyOwner {
        maxBNBPurchase = _maxBNBPurchase;
        emit MaxBNBPurchaseUpdated(maxBNBPurchase);
    }

    /**
     * @notice Set the funds wallet where BNB raised is held
     * @param _fundsWallet The new address to forward BNB and Synths to
     */
    function setFundsWallet(address _fundsWallet) external onlyOwner {
        fundsWallet = _fundsWallet;
        emit FundsWalletUpdated(fundsWallet);
    }

    /**
     * @notice Set the minimum deposit amount required to depoist oUSD into the FIFO queue
     * @param _amount The new new minimum number of oUSD required to deposit
     */
    function setMinimumDepositAmount(uint _amount) external onlyOwner {
        // Do not allow us to set it less than 1 dollar opening up to fractional desposits in the queue again
        require(_amount > SafeDecimalMath.unit(), "Minimum deposit amount must be greater than UNIT");
        minimumDepositAmount = _amount;
        emit MinimumDepositAmountUpdated(minimumDepositAmount);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    /**
     * @notice Fallback function (exchanges BNB to oUSD)
     */
    function() external payable {
        exchangeEtherForSynths();
    }

    /**
     * @notice Exchange BNB to oUSD.
     */
    function exchangeEtherForSynths()
        public
        payable
        nonReentrant
        rateNotStale(BNB)
        notPaused
        returns (
            uint // Returns the number of Synths (oUSD) received
        )
    {
        require(msg.value <= maxBNBPurchase, "BNB amount above maxBNBPurchase limit");
        uint BNBToSend;

        // The multiplication works here because exchangeRates().rateForCurrency(BNB) is specified in
        // 18 decimal places, just like our currency base.
        uint requestedToPurchase = msg.value.multiplyDecimal(exchangeRates().rateForCurrency(BNB));
        uint remainingToFulfill = requestedToPurchase;

        // Iterate through our outstanding deposits and sell them one at a time.
        for (uint i = depositStartIndex; remainingToFulfill > 0 && i < depositEndIndex; i++) {
            synthDeposit memory deposit = deposits[i];

            // If it's an empty spot in the queue from a previous withdrawal, just skip over it and
            // update the queue. It's already been deleted.
            if (deposit.user == address(0)) {
                depositStartIndex = depositStartIndex.add(1);
            } else {
                // If the deposit can more than fill the order, we can do this
                // without touching the structure of our queue.
                if (deposit.amount > remainingToFulfill) {
                    // Ok, this deposit can fulfill the whole remainder. We don't need
                    // to change anything about our queue we can just fulfill it.
                    // Subtract the amount from our deposit and total.
                    uint newAmount = deposit.amount.sub(remainingToFulfill);
                    deposits[i] = synthDeposit({user: deposit.user, amount: newAmount});

                    totalSellableDeposits = totalSellableDeposits.sub(remainingToFulfill);

                    // Transfer the BNB to the depositor. Send is used instead of transfer
                    // so a non payable contract won't block the FIFO queue on a failed
                    // BNB payable for synths transaction. The proceeds to be sent to the
                    // oikos foundation funds wallet. This is to protect all depositors
                    // in the queue in this rare case that may occur.
                    BNBToSend = remainingToFulfill.divideDecimal(exchangeRates().rateForCurrency(BNB));

                    // We need to use send here instead of transfer because transfer reverts
                    // if the recipient is a non-payable contract. Send will just tell us it
                    // failed by returning false at which point we can continue.
                    // solium-disable-next-line security/no-send
                    if (!deposit.user.send(BNBToSend)) {
                        fundsWallet.transfer(BNBToSend);
                        emit NonPayableContract(deposit.user, BNBToSend);
                    } else {
                        emit ClearedDeposit(msg.sender, deposit.user, BNBToSend, remainingToFulfill, i);
                    }

                    // And the Synths to the recipient.
                    // Note: Fees are calculated by the Synth contract, so when
                    //       we request a specific transfer here, the fee is
                    //       automatically deducted and sent to the fee pool.
                    synthoUSD().transfer(msg.sender, remainingToFulfill);

                    // And we have nothing left to fulfill on this order.
                    remainingToFulfill = 0;
                } else if (deposit.amount <= remainingToFulfill) {
                    // We need to fulfill this one in its entirety and kick it out of the queue.
                    // Start by kicking it out of the queue.
                    // Free the storage because we can.
                    delete deposits[i];
                    // Bump our start index forward one.
                    depositStartIndex = depositStartIndex.add(1);
                    // We also need to tell our total it's decreased
                    totalSellableDeposits = totalSellableDeposits.sub(deposit.amount);

                    // Now fulfill by transfering the BNB to the depositor. Send is used instead of transfer
                    // so a non payable contract won't block the FIFO queue on a failed
                    // BNB payable for synths transaction. The proceeds to be sent to the
                    // oikos foundation funds wallet. This is to protect all depositors
                    // in the queue in this rare case that may occur.
                    BNBToSend = deposit.amount.divideDecimal(exchangeRates().rateForCurrency(BNB));

                    // We need to use send here instead of transfer because transfer reverts
                    // if the recipient is a non-payable contract. Send will just tell us it
                    // failed by returning false at which point we can continue.
                    // solium-disable-next-line security/no-send
                    if (!deposit.user.send(BNBToSend)) {
                        fundsWallet.transfer(BNBToSend);
                        emit NonPayableContract(deposit.user, BNBToSend);
                    } else {
                        emit ClearedDeposit(msg.sender, deposit.user, BNBToSend, deposit.amount, i);
                    }

                    // And the Synths to the recipient.
                    // Note: Fees are calculated by the Synth contract, so when
                    //       we request a specific transfer here, the fee is
                    //       automatically deducted and sent to the fee pool.
                    synthoUSD().transfer(msg.sender, deposit.amount);

                    // And subtract the order from our outstanding amount remaining
                    // for the next iteration of the loop.
                    remainingToFulfill = remainingToFulfill.sub(deposit.amount);
                }
            }
        }

        // Ok, if we're here and 'remainingToFulfill' isn't zero, then
        // we need to refund the remainder of their BNB back to them.
        if (remainingToFulfill > 0) {
            msg.sender.transfer(remainingToFulfill.divideDecimal(exchangeRates().rateForCurrency(BNB)));
        }

        // How many did we actually give them?
        uint fulfilled = requestedToPurchase.sub(remainingToFulfill);

        if (fulfilled > 0) {
            // Now tell everyone that we gave them that many (only if the amount is greater than 0).
            emit Exchange("BNB", msg.value, "oUSD", fulfilled);
        }

        return fulfilled;
    }

    /**
     * @notice Exchange BNB to oUSD while insisting on a particular rate. This allows a user to
     *         exchange while protecting against frontrunning by the contract owner on the exchange rate.
     * @param guaranteedRate The exchange rate (Ether price) which must be honored or the call will revert.
     */
    function exchangeEtherForSynthsAtRate(uint guaranteedRate)
        public
        payable
        rateNotStale(BNB)
        notPaused
        returns (
            uint // Returns the number of Synths (oUSD) received
        )
    {
        require(guaranteedRate == exchangeRates().rateForCurrency(BNB), "Guaranteed rate would not be received");

        return exchangeEtherForSynths();
    }

    /**
     * @notice Exchange BNB to OKS.
     */
    function exchangeEtherForOKS()
        public
        payable
        rateNotStale(OKS)
        rateNotStale(BNB)
        notPaused
        returns (
            uint // Returns the number of OKS received
        )
    {
        // How many OKS are they going to be receiving?
        uint oikosToSend = oikosReceivedForEther(msg.value);

        // Store the BNB in our funds wallet
        fundsWallet.transfer(msg.value);

        // And send them the OKS.
        oikos().transfer(msg.sender, oikosToSend);

        emit Exchange("BNB", msg.value, "OKS", oikosToSend);

        return oikosToSend;
    }

    /**
     * @notice Exchange BNB to OKS while insisting on a particular set of rates. This allows a user to
     *         exchange while protecting against frontrunning by the contract owner on the exchange rates.
     * @param guaranteedEtherRate The Ether exchange rate which must be honored or the call will revert.
     * @param guaranteedOikosRate The oikos exchange rate which must be honored or the call will revert.
     */
    function exchangeEtherForOKSAtRate(uint guaranteedEtherRate, uint guaranteedOikosRate)
        public
        payable
        rateNotStale(OKS)
        rateNotStale(BNB)
        notPaused
        returns (
            uint // Returns the number of OKS received
        )
    {
        require(guaranteedEtherRate == exchangeRates().rateForCurrency(BNB), "Guaranteed BNB rate would not be received");
        require(
            guaranteedOikosRate == exchangeRates().rateForCurrency(OKS),
            "Guaranteed oikos rate would not be received"
        );

        return exchangeEtherForOKS();
    }

    /**
     * @notice Exchange oUSD for OKS
     * @param synthAmount The amount of synths the user wishes to exchange.
     */
    function exchangeSynthsForOKS(uint synthAmount)
        public
        rateNotStale(OKS)
        notPaused
        returns (
            uint // Returns the number of OKS received
        )
    {
        // How many OKS are they going to be receiving?
        uint oikosToSend = oikosReceivedForSynths(synthAmount);

        // Ok, transfer the Synths to our funds wallet.
        // These do not go in the deposit queue as they aren't for sale as such unless
        // they're sent back in from the funds wallet.
        synthoUSD().transferFrom(msg.sender, fundsWallet, synthAmount);

        // And send them the OKS.
        oikos().transfer(msg.sender, oikosToSend);

        emit Exchange("oUSD", synthAmount, "OKS", oikosToSend);

        return oikosToSend;
    }

    /**
     * @notice Exchange oUSD for OKS while insisting on a particular rate. This allows a user to
     *         exchange while protecting against frontrunning by the contract owner on the exchange rate.
     * @param synthAmount The amount of synths the user wishes to exchange.
     * @param guaranteedRate A rate (oikos price) the caller wishes to insist upon.
     */
    function exchangeSynthsForOKSAtRate(uint synthAmount, uint guaranteedRate)
        public
        rateNotStale(OKS)
        notPaused
        returns (
            uint // Returns the number of OKS received
        )
    {
        require(guaranteedRate == exchangeRates().rateForCurrency(OKS), "Guaranteed rate would not be received");

        return exchangeSynthsForOKS(synthAmount);
    }

    /**
     * @notice Allows the owner to withdraw OKS from this contract if needed.
     * @param amount The amount of OKS to attempt to withdraw (in 18 decimal places).
     */
    function withdrawOikos(uint amount) external onlyOwner {
        oikos().transfer(owner, amount);

        // We don't emit our own events here because we assume that anyone
        // who wants to watch what the Depot is doing can
        // just watch ERC20 events from the Synth and/or Oikos contracts
        // filtered to our address.
    }

    /**
     * @notice Allows a user to withdraw all of their previously deposited synths from this contract if needed.
     *         Developer note: We could keep an index of address to deposits to make this operation more efficient
     *         but then all the other operations on the queue become less efficient. It's expected that this
     *         function will be very rarely used, so placing the inefficiency here is intentional. The usual
     *         use case does not involve a withdrawal.
     */
    function withdrawMyDepositedSynths() external {
        uint synthsToSend = 0;

        for (uint i = depositStartIndex; i < depositEndIndex; i++) {
            synthDeposit memory deposit = deposits[i];

            if (deposit.user == msg.sender) {
                // The user is withdrawing this deposit. Remove it from our queue.
                // We'll just leave a gap, which the purchasing logic can walk past.
                synthsToSend = synthsToSend.add(deposit.amount);
                delete deposits[i];
                //Let the DApps know we've removed this deposit
                emit SynthDepositRemoved(deposit.user, deposit.amount, i);
            }
        }

        // Update our total
        totalSellableDeposits = totalSellableDeposits.sub(synthsToSend);

        // Check if the user has tried to send deposit amounts < the minimumDepositAmount to the FIFO
        // queue which would have been added to this mapping for withdrawal only
        synthsToSend = synthsToSend.add(smallDeposits[msg.sender]);
        smallDeposits[msg.sender] = 0;

        // If there's nothing to do then go ahead and revert the transaction
        require(synthsToSend > 0, "You have no deposits to withdraw.");

        // Send their deposits back to them (minus fees)
        synthoUSD().transfer(msg.sender, synthsToSend);

        emit SynthWithdrawal(msg.sender, synthsToSend);
    }

    /**
     * @notice depositSynths: Allows users to deposit synths via the approve / transferFrom workflow
     * @param amount The amount of oUSD you wish to deposit (must have been approved first)
     */
    function depositSynths(uint amount) external {
        // Grab the amount of synths. Will fail if not approved first
        synthoUSD().transferFrom(msg.sender, this, amount);

        // A minimum deposit amount is designed to protect purchasers from over paying
        // gas for fullfilling multiple small synth deposits
        if (amount < minimumDepositAmount) {
            // We cant fail/revert the transaction or send the synths back in a reentrant call.
            // So we will keep your synths balance seperate from the FIFO queue so you can withdraw them
            smallDeposits[msg.sender] = smallDeposits[msg.sender].add(amount);

            emit SynthDepositNotAccepted(msg.sender, amount, minimumDepositAmount);
        } else {
            // Ok, thanks for the deposit, let's queue it up.
            deposits[depositEndIndex] = synthDeposit({user: msg.sender, amount: amount});
            emit SynthDeposit(msg.sender, amount, depositEndIndex);

            // Walk our index forward as well.
            depositEndIndex = depositEndIndex.add(1);

            // And add it to our total.
            totalSellableDeposits = totalSellableDeposits.add(amount);
        }
    }

    /* ========== VIEWS ========== */

    /**
     * @notice Calculate how many OKS you will receive if you transfer
     *         an amount of synths.
     * @param amount The amount of synths (in 18 decimal places) you want to ask about
     */
    function oikosReceivedForSynths(uint amount) public view returns (uint) {
        // And what would that be worth in OKS based on the current price?
        return amount.divideDecimal(exchangeRates().rateForCurrency(OKS));
    }

    /**
     * @notice Calculate how many OKS you will receive if you transfer
     *         an amount of Ether.
     * @param amount The amount of Ether (in wei) you want to ask about
     */
    function oikosReceivedForEther(uint amount) public view returns (uint) {
        // How much is the BNB they sent us worth in oUSD (ignoring the transfer fee)?
        uint valueSentInSynths = amount.multiplyDecimal(exchangeRates().rateForCurrency(BNB));

        // Now, how many OKS will that USD amount buy?
        return oikosReceivedForSynths(valueSentInSynths);
    }

    /**
     * @notice Calculate how many synths you will receive if you transfer
     *         an amount of Ether.
     * @param amount The amount of Ether (in wei) you want to ask about
     */
    function synthsReceivedForEther(uint amount) public view returns (uint) {
        // How many synths would that amount of Ether be worth?
        return amount.multiplyDecimal(exchangeRates().rateForCurrency(BNB));
    }

    /* ========== INTERNAL VIEWS ========== */

    function synthoUSD() internal view returns (ISynth) {
        return ISynth(resolver.requireAndGetAddress("SynthoUSD", "Missing SynthoUSD address"));
    }

    function oikos() internal view returns (IERC20) {
        return IERC20(resolver.requireAndGetAddress("Oikos", "Missing Oikos address"));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(resolver.requireAndGetAddress("ExchangeRates", "Missing ExchangeRates address"));
    }

    // ========== MODIFIERS ==========

    modifier rateNotStale(bytes32 currencyKey) {
        require(!exchangeRates().rateIsStale(currencyKey), "Rate stale or not a synth");
        _;
    }

    /* ========== EVENTS ========== */

    event MaxBNBPurchaseUpdated(uint amount);
    event FundsWalletUpdated(address newFundsWallet);
    event Exchange(string fromCurrency, uint fromAmount, string toCurrency, uint toAmount);
    event SynthWithdrawal(address user, uint amount);
    event SynthDeposit(address indexed user, uint amount, uint indexed depositIndex);
    event SynthDepositRemoved(address indexed user, uint amount, uint indexed depositIndex);
    event SynthDepositNotAccepted(address user, uint amount, uint minimum);
    event MinimumDepositAmountUpdated(uint amount);
    event NonPayableContract(address indexed receiver, uint amount);
    event ClearedDeposit(
        address indexed fromAddress,
        address indexed toAddress,
        uint fromBNBAmount,
        uint toAmount,
        uint indexed depositIndex
    );
}
