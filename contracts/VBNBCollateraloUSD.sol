pragma solidity ^0.5.16;

// Inheritance
import "./Owned.sol";
import "./Pausable.sol";
import "openzeppelin-solidity-2.3.0/contracts/utils/ReentrancyGuard.sol";
import "./MixinResolver.sol";

// Libraries
import "./SafeDecimalMath.sol";

// Internal references
import "./interfaces/ISystemStatus.sol";
import "./interfaces/IFeePool.sol";
import "./interfaces/ISynth.sol";
import "./interfaces/IERC20.sol";
import "./interfaces/IExchangeRates.sol";


// VBNB Collateral v0.1 (oUSD)
contract VBNBCollateraloUSD is Owned, Pausable, ReentrancyGuard, MixinResolver {
    using SafeMath for uint256;
    using SafeDecimalMath for uint256;

    // ========== CONSTANTS ==========
    uint256 internal constant ONE_THOUSAND = 1e18 * 1000;
    uint256 internal constant ONE_HUNDRED = 1e18 * 100;

    uint256 internal constant SECONDS_IN_A_YEAR = 31536000; // Common Year

    // Where fees are pooled in oUSD.
    address internal constant FEE_ADDRESS = 0xfeEFEEfeefEeFeefEEFEEfEeFeefEEFeeFEEFEeF;

    uint256 internal constant ACCOUNT_LOAN_LIMIT_CAP = 1000;
    bytes32 private constant oUSD = "oUSD";
    bytes32 public constant COLLATERAL = "VBNB";
    bytes32 internal constant VBNB = "VBNB";

    uint public OUSD_DECIMALS = 18;
    uint public VBNB_DECIMALS = 8;

    //The underlying vToken
    address public vToken; 
    // ========== SETTER STATE VARIABLES ==========

    // The ratio of Collateral to synths issued
    uint256 public collateralizationRatio = SafeDecimalMath.unit() * 150;

    // If updated, all outstanding loans will pay this interest rate in on closure of the loan. Default 5%
    uint256 public interestRate = (5 * SafeDecimalMath.unit()) / 100;
    uint256 public interestPerSecond = interestRate.div(SECONDS_IN_A_YEAR);

    // Minting fee for issuing the synths. Default 50 bips.
    uint256 public issueFeeRate = (5 * SafeDecimalMath.unit()) / 1000;

    // Maximum amount of oUSD that can be issued by the EtherCollateral contract. Default 10MM
    uint256 public issueLimit = SafeDecimalMath.unit() * 10000000;

    // Minimum amount of VBNB to create loan preventing griefing and gas consumption. Min 1VBNB
    uint256 public minLoanCollateralSize = (SafeDecimalMath.unit() * 1).div(2);

    // Maximum number of loans an account can create
    uint256 public accountLoanLimit = 50;

    // If true then any wallet addres can close a loan not just the loan creator.
    bool public loanLiquidationOpen = false;

    // Time when remaining loans can be liquidated
    uint256 public liquidationDeadline;

    // Liquidation ratio when loans can be liquidated
    uint256 public liquidationRatio = (150 * SafeDecimalMath.unit()) / 100; // 1.5 ratio

    // Liquidation penalty when loans are liquidated. default 10%
    uint256 public liquidationPenalty = SafeDecimalMath.unit() / 10;

    // ========== STATE VARIABLES ==========

    // The total number of synths issued by the collateral in this contract
    uint256 public totalIssuedSynths;

    // Total number of loans ever created
    uint256 public totalLoansCreated;

    // Total number of open loans
    uint256 public totalOpenLoanCount;

    // Synth loan storage struct
    struct SynthLoanStruct {
        //  Acccount that created the loan
        address payable account;
        //  Amount (in collateral token ) that they deposited
        uint256 collateralAmount;
        //  Amount (in synths) that they issued to borrow
        uint256 loanAmount;
        // Minting Fee
        uint256 mintingFee;
        // When the loan was created
        uint256 timeCreated;
        // ID for the loan
        uint256 loanID;
        // When the loan was paidback (closed)
        uint256 timeClosed;
        // Applicable Interest rate
        uint256 loanInterestRate;
        // interest amounts accrued
        uint256 accruedInterest;
        // last timestamp interest amounts accrued
        uint40 lastInterestAccrued;
    }

    // Users Loans by address
    mapping(address => SynthLoanStruct[]) public accountsSynthLoans;

    // Account Open Loan Counter
    mapping(address => uint256) public accountOpenLoanCounter;

    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */

    bytes32 private constant CONTRACT_SYSTEMSTATUS = "SystemStatus";
    bytes32 private constant CONTRACT_SYNTHOUSD = "SynthoUSD";
    bytes32 private constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 private constant CONTRACT_FEEPOOL = "FeePool";
    bytes32 private constant CONTRACT_DEPOT = "Depot";

    bytes32[24] private addressesToCache = [
        CONTRACT_SYSTEMSTATUS,
        CONTRACT_SYNTHOUSD,
        CONTRACT_EXRATES,
        CONTRACT_FEEPOOL,
        CONTRACT_DEPOT      
    ];


    // ========== CONSTRUCTOR ==========
    constructor(address _owner, address _resolver) public Owned(_owner) Pausable() MixinResolver(_resolver, addressesToCache) {
        address VBNB_ADDRESS = 0xA07c5b74C9B40447a954e1466938b865b6BBea36;
        vToken = VBNB_ADDRESS;
        liquidationDeadline = block.timestamp + 92 days; // Time before loans can be open for liquidation to end the trial contract
    }

    // ========== SETTERS ==========

    function setVToken(address _vToken) external onlyOwner {
        vToken = _vToken;
    }

    function setCollateralizationRatio(uint256 ratio) external onlyOwner {
        require(ratio <= ONE_THOUSAND, "Too high");
        require(ratio >= ONE_HUNDRED, "Too low");
        collateralizationRatio = ratio;
        emit CollateralizationRatioUpdated(ratio);
    }

    function setInterestRate(uint256 _interestRate) external onlyOwner {
        require(_interestRate > SECONDS_IN_A_YEAR, "Interest rate cannot be less that the SECONDS_IN_A_YEAR");
        require(_interestRate <= SafeDecimalMath.unit(), "Interest cannot be more than 100% APR");
        interestRate = _interestRate;
        interestPerSecond = _interestRate.div(SECONDS_IN_A_YEAR);
        emit InterestRateUpdated(interestRate);
    }

    function setIssueFeeRate(uint256 _issueFeeRate) external onlyOwner {
        issueFeeRate = _issueFeeRate;
        emit IssueFeeRateUpdated(issueFeeRate);
    }

    function setIssueLimit(uint256 _issueLimit) external onlyOwner {
        issueLimit = _issueLimit;
        emit IssueLimitUpdated(issueLimit);
    }

    function setMinLoanCollateralSize(uint256 _minLoanCollateralSize) external onlyOwner {
        minLoanCollateralSize = _minLoanCollateralSize;
        emit MinLoanCollateralSizeUpdated(minLoanCollateralSize);
    }

    function setAccountLoanLimit(uint256 _loanLimit) external onlyOwner {
        require(_loanLimit < ACCOUNT_LOAN_LIMIT_CAP, "Owner cannot set higher than ACCOUNT_LOAN_LIMIT_CAP");
        accountLoanLimit = _loanLimit;
        emit AccountLoanLimitUpdated(accountLoanLimit);
    }

    function setLoanLiquidationOpen(bool _loanLiquidationOpen) external onlyOwner {
        require(block.timestamp > liquidationDeadline, "Before liquidation deadline");
        loanLiquidationOpen = _loanLiquidationOpen;
        emit LoanLiquidationOpenUpdated(loanLiquidationOpen);
    }

    function setLiquidationRatio(uint256 _liquidationRatio) external onlyOwner {
        require(_liquidationRatio > SafeDecimalMath.unit(), "Ratio less than 100%");
        liquidationRatio = _liquidationRatio;
        emit LiquidationRatioUpdated(liquidationRatio);
    }

    // ========== PUBLIC VIEWS ==========

    function getContractInfo()
        external
        view
        returns (
            uint256 _collateralizationRatio,
            uint256 _issuanceRatio,
            uint256 _interestRate,
            uint256 _interestPerSecond,
            uint256 _issueFeeRate,
            uint256 _issueLimit,
            uint256 _minLoanCollateralSize,
            uint256 _totalIssuedSynths,
            uint256 _totalLoansCreated,
            uint256 _totalOpenLoanCount,
            uint256 _ethBalance,
            uint256 _liquidationDeadline,
            bool _loanLiquidationOpen
        )
    {
        _collateralizationRatio = collateralizationRatio;
        _issuanceRatio = issuanceRatio();
        _interestRate = interestRate;
        _interestPerSecond = interestPerSecond;
        _issueFeeRate = issueFeeRate;
        _issueLimit = issueLimit;
        _minLoanCollateralSize = minLoanCollateralSize;
        _totalIssuedSynths = totalIssuedSynths;
        _totalLoansCreated = totalLoansCreated;
        _totalOpenLoanCount = totalOpenLoanCount;
        _ethBalance = address(this).balance;
        _liquidationDeadline = liquidationDeadline;
        _loanLiquidationOpen = loanLiquidationOpen;
    }

    // returns value of 100 / collateralizationRatio.
    // e.g. 100/150 = 0.6666666667
    function issuanceRatio() public view returns (uint256) {
        // this rounds so you get slightly more rather than slightly less
        return ONE_HUNDRED.divideDecimalRound(collateralizationRatio);
    }

    function loanAmountFromCollateral(uint256 collateralAmount) public view returns (uint256) {
        // a fraction more is issued due to rounding
        return collateralAmount.multiplyDecimal(issuanceRatio()).multiplyDecimal(exchangeRates().rateForCurrency("BNB"));
    }

    function collateralAmountForLoan(uint256 loanAmount) external view returns (uint256) {
        return
            loanAmount
                .multiplyDecimal(collateralizationRatio.divideDecimalRound(exchangeRates().rateForCurrency("BNB")))
                .divideDecimalRound(ONE_HUNDRED);
    }

    // compound accrued interest with remaining loanAmount * (now - lastTimestampInterestPaid)
    function currentInterestOnLoan(address _account, uint256 _loanID) external view returns (uint256) {
        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);
        uint256 currentInterest =
            accruedInterestOnLoan(synthLoan.loanAmount.add(synthLoan.accruedInterest), _timeSinceInterestAccrual(synthLoan));
        return synthLoan.accruedInterest.add(currentInterest);
    }

    function accruedInterestOnLoan(uint256 _loanAmount, uint256 _seconds) public view returns (uint256 interestAmount) {
        // Simple interest calculated per second
        // Interest = Principal * rate * time
        interestAmount = _loanAmount.multiplyDecimalRound(interestPerSecond.mul(_seconds));
    }

    function totalFeesOnLoan(address _account, uint256 _loanID)
        external
        view
        returns (uint256 interestAmount, uint256 mintingFee)
    {
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);
        uint256 loanAmountWithAccruedInterest = synthLoan.loanAmount.add(synthLoan.accruedInterest);
        interestAmount = synthLoan.accruedInterest.add(
            accruedInterestOnLoan(loanAmountWithAccruedInterest, _timeSinceInterestAccrual(synthLoan))
        );
        mintingFee = synthLoan.mintingFee;
    }

    function getMintingFee(address _account, uint256 _loanID) external view returns (uint256) {
        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);
        return synthLoan.mintingFee;
    }

    /**
     * r = target issuance ratio
     * D = debt balance
     * V = Collateral
     * P = liquidation penalty
     * Calculates amount of synths = (D - V * r) / (1 - (1 + P) * r)
     */
    function calculateAmountToLiquidate(uint debtBalance, uint collateral) public view returns (uint) {
        uint unit = SafeDecimalMath.unit();
        uint ratio = liquidationRatio;

        uint dividend = debtBalance.sub(collateral.divideDecimal(ratio));
        uint divisor = unit.sub(unit.add(liquidationPenalty).divideDecimal(ratio));

        return dividend.divideDecimal(divisor);
    }

    function openLoanIDsByAccount(address _account) external view returns (uint256[] memory) {
        SynthLoanStruct[] memory synthLoans = accountsSynthLoans[_account];

        uint256[] memory _openLoanIDs = new uint256[](synthLoans.length);
        uint256 _counter = 0;

        for (uint256 i = 0; i < synthLoans.length; i++) {
            if (synthLoans[i].timeClosed == 0) {
                _openLoanIDs[_counter] = synthLoans[i].loanID;
                _counter++;
            }
        }
        // Create the fixed size array to return
        uint256[] memory _result = new uint256[](_counter);

        // Copy loanIDs from dynamic array to fixed array
        for (uint256 j = 0; j < _counter; j++) {
            _result[j] = _openLoanIDs[j];
        }
        // Return an array with list of open Loan IDs
        return _result;
    }

    function getLoan(address _account, uint256 _loanID)
        external
        view
        returns (
            address account,
            uint256 collateralAmount,
            uint256 loanAmount,
            uint256 timeCreated,
            uint256 loanID,
            uint256 timeClosed,
            uint256 accruedInterest,
            uint256 totalFees
        )
    {
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);
        account = synthLoan.account;
        collateralAmount = synthLoan.collateralAmount;
        loanAmount = synthLoan.loanAmount;
        timeCreated = synthLoan.timeCreated;
        loanID = synthLoan.loanID;
        timeClosed = synthLoan.timeClosed;
        accruedInterest = synthLoan.accruedInterest.add(
            accruedInterestOnLoan(synthLoan.loanAmount.add(synthLoan.accruedInterest), _timeSinceInterestAccrual(synthLoan))
        );
        totalFees = accruedInterest.add(synthLoan.mintingFee);
    }

    function getLoanCollateralRatio(address _account, uint256 _loanID) external view returns (uint256 loanCollateralRatio) {
        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);

        (loanCollateralRatio, , ) = _loanCollateralRatio(synthLoan);
    }

    function _loanCollateralRatio(SynthLoanStruct memory _loan)
        internal
        view
        returns (
            uint256 loanCollateralRatio,
            uint256 collateralValue,
            uint256 interestAmount
        )
    {
        // Any interest accrued prior is rolled up into loan amount
        uint256 loanAmountWithAccruedInterest = _loan.loanAmount.add(_loan.accruedInterest);

        interestAmount = accruedInterestOnLoan(loanAmountWithAccruedInterest, _timeSinceInterestAccrual(_loan));

        collateralValue = _loan.collateralAmount.multiplyDecimal(exchangeRates().rateForCurrency(COLLATERAL));

        loanCollateralRatio = collateralValue.divideDecimal(loanAmountWithAccruedInterest.add(interestAmount));
    }

    function timeSinceInterestAccrualOnLoan(address _account, uint256 _loanID) external view returns (uint256) {
        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_account, _loanID);

        return _timeSinceInterestAccrual(synthLoan);
    }

    // ========== PUBLIC FUNCTIONS ==========

 

    function openLoan(uint256 _loanAmount, uint256 _collateral)
        external
        notPaused
        nonReentrant
        VBNBRateNotInvalid
        returns (uint256 loanID)
    {
        systemStatus().requireIssuanceActive();

        //require vBNB to be transferred to the contract. Needs prior approval.
        require(IERC20(vToken).transferFrom(msg.sender, address(this), _collateral), 'vBNB transferFrom failed.');

        //VBNB has 8 decimals precision
        uint scaledAmount = _collateral.mul((10**(OUSD_DECIMALS - VBNB_DECIMALS)));

        // Require VBNB sent to be greater than minLoanCollateralSize
        require(
            scaledAmount >= minLoanCollateralSize,
            "Not enough VBNB to create this loan. Please see the minLoanCollateralSize"
        );

        // Require loanLiquidationOpen to be false or we are in liquidation phase
        require(loanLiquidationOpen == false, "Loans are now being liquidated");

        // Each account is limited to creating 50 (accountLoanLimit) loans
        require(accountsSynthLoans[msg.sender].length < accountLoanLimit, "Each account is limited to 50 loans");

        //get BNB value of vBNB collateral
        uint vBNBValue = exchangeRates().effectiveValue("VBNB", scaledAmount, "BNB");

        // Calculate issuance amount based on issuance ratio
        uint256 maxLoanAmount = loanAmountFromCollateral(vBNBValue);

        // Require requested _loanAmount to be less than maxLoanAmount
        // Issuance ratio caps collateral to loan value at 150%
        require(_loanAmount <= maxLoanAmount, "Loan amount exceeds max borrowing power");

        uint256 mintingFee = _calculateMintingFee(_loanAmount);
        uint256 loanAmountMinusFee = _loanAmount.sub(mintingFee);

        // Require oUSD loan to mint does not exceed cap
        require(totalIssuedSynths.add(_loanAmount) <= issueLimit, "Loan Amount exceeds the supply cap.");

        // Get a Loan ID
        loanID = _incrementTotalLoansCounter();

        // Create Loan storage object
        SynthLoanStruct memory synthLoan =
            SynthLoanStruct({
                account: msg.sender,
                collateralAmount: scaledAmount,
                loanAmount: _loanAmount,
                mintingFee: mintingFee,
                timeCreated: block.timestamp,
                loanID: loanID,
                timeClosed: 0,
                loanInterestRate: interestRate,
                accruedInterest: 0,
                lastInterestAccrued: 0
            });

        // Fee distribution. Mint the oUSD fees into the FeePool and record fees paid
        if (mintingFee > 0) {
            synthoUSD().issue(address(this), mintingFee);
            //this will trigger automatic recording of fees paid
            IERC20(address(synthoUSD())).transfer(FEE_ADDRESS, mintingFee);
        }

        // Record loan in mapping to account in an array of the accounts open loans
        accountsSynthLoans[msg.sender].push(synthLoan);

        // Increment totalIssuedSynths
        totalIssuedSynths = totalIssuedSynths.add(_loanAmount);
        //uint actualLoanAmount =  exchangeRates().effectiveValue("oUSD", _amount, "oBNB");

        // Issue the synth (less fee)
        synthoUSD().issue(msg.sender, loanAmountMinusFee);

        // Tell the Dapps a loan was created
        emit LoanCreated(msg.sender, loanID, _loanAmount);
    }

    function closeLoan(uint256 loanID) external nonReentrant VBNBRateNotInvalid {
        _closeLoan(msg.sender, loanID, false);
    }

    // Add VBNB collateral to an open loan
    function depositCollateral(address account, uint256 loanID, uint256 _amount) external notPaused {
        require(_amount > 0, "Deposit amount must be greater than 0");

        systemStatus().requireIssuanceActive();
        require(IERC20(vToken).transferFrom(msg.sender, address(this), _amount), 'vBNB transferFrom failed.');

        uint scaledAmount = _amount.mul((10**(OUSD_DECIMALS - VBNB_DECIMALS)));

        // Require loanLiquidationOpen to be false or we are in liquidation phase
        require(loanLiquidationOpen == false, "Loans are now being liquidated");

        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(account, loanID);

        // Check loan exists and is open
        _checkLoanIsOpen(synthLoan);

        uint256 totalCollateral = synthLoan.collateralAmount.add(scaledAmount);

        _updateLoanCollateral(synthLoan, totalCollateral);

        // Tell the Dapps collateral was added to loan
        emit CollateralDeposited(account, loanID, scaledAmount, totalCollateral);
    }

    // Withdraw VBNB collateral from an open loan
    function withdrawCollateral(uint256 loanID, uint256 withdrawAmount) external notPaused nonReentrant VBNBRateNotInvalid {
        require(withdrawAmount > 0, "Amount to withdraw must be greater than 0");

        systemStatus().requireIssuanceActive();

        // Require loanLiquidationOpen to be false or we are in liquidation phase
        require(loanLiquidationOpen == false, "Loans are now being liquidated");

        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(msg.sender, loanID);

        // Check loan exists and is open
        _checkLoanIsOpen(synthLoan);

        uint256 collateralAfter = synthLoan.collateralAmount.sub(withdrawAmount);

        SynthLoanStruct memory loanAfter = _updateLoanCollateral(synthLoan, collateralAfter);

        // require collateral ratio after to be above the liquidation ratio
        (uint256 collateralRatioAfter, , ) = _loanCollateralRatio(loanAfter);

        require(collateralRatioAfter > liquidationRatio, "Collateral ratio below liquidation after withdraw");

        // transfer VBNB to msg.sender
        IERC20(vToken).transfer(msg.sender, withdrawAmount.div((10**(OUSD_DECIMALS - VBNB_DECIMALS))));

        // Tell the Dapps collateral was added to loan
        emit CollateralWithdrawn(msg.sender, loanID, withdrawAmount, loanAfter.collateralAmount);
    }

    function repayLoan(
        address _loanCreatorsAddress,
        uint256 _loanID,
        uint256 _repayAmount
    ) external VBNBRateNotInvalid {
        systemStatus().requireSystemActive();

        // check msg.sender has sufficient oUSD to pay
        require(IERC20(address(synthoUSD())).balanceOf(msg.sender) >= _repayAmount, "Not enough oUSD balance");
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_loanCreatorsAddress, _loanID);

        // Check loan exists and is open
        _checkLoanIsOpen(synthLoan);

        // Any interest accrued prior is rolled up into loan amount
        uint256 loanAmountWithAccruedInterest = synthLoan.loanAmount.add(synthLoan.accruedInterest);
        uint256 interestAmount = accruedInterestOnLoan(loanAmountWithAccruedInterest, _timeSinceInterestAccrual(synthLoan));

        // repay any accrued interests first
        // and repay principal loan amount with remaining amounts
        uint256 accruedInterest = synthLoan.accruedInterest.add(interestAmount);

        (uint256 interestPaid, uint256 loanAmountPaid, uint256 accruedInterestAfter, uint256 loanAmountAfter) =
            _splitInterestLoanPayment(_repayAmount, accruedInterest, synthLoan.loanAmount);

        // burn oUSD from msg.sender for repaid amount
        synthoUSD().burn(msg.sender, _repayAmount);

        // Send interest paid to fee pool and record loan amount paid
        _processInterestAndLoanPayment(interestPaid, loanAmountPaid);

        // update loan with new total loan amount, record accrued interests
        _updateLoan(synthLoan, loanAmountAfter, accruedInterestAfter, block.timestamp);

        emit LoanRepaid(_loanCreatorsAddress, _loanID, _repayAmount, loanAmountAfter);
    }

    // Liquidate loans at or below issuance ratio
    function liquidateLoan(
        address _loanCreatorsAddress,
        uint256 _loanID,
        uint256 _debtToCover
    ) external nonReentrant VBNBRateNotInvalid {
        systemStatus().requireSystemActive();

        // check msg.sender (liquidator's wallet) has sufficient oUSD
        require(IERC20(address(synthoUSD())).balanceOf(msg.sender) >= _debtToCover, "Not enough oUSD balance");

        SynthLoanStruct memory synthLoan = _getLoanFromStorage(_loanCreatorsAddress, _loanID);

        // Check loan exists and is open
        _checkLoanIsOpen(synthLoan);

        (uint256 collateralRatio, uint256 collateralValue, uint256 interestAmount) = _loanCollateralRatio(synthLoan);

        require(collateralRatio < liquidationRatio, "Collateral ratio above liquidation ratio");

        // calculate amount to liquidate to fix ratio including accrued interest
        uint256 liquidationAmount =
            calculateAmountToLiquidate(
                synthLoan.loanAmount.add(synthLoan.accruedInterest).add(interestAmount),
                collateralValue
            );

        // cap debt to liquidate
        uint256 amountToLiquidate = liquidationAmount < _debtToCover ? liquidationAmount : _debtToCover;

        // burn oUSD from msg.sender for amount to liquidate
        synthoUSD().burn(msg.sender, amountToLiquidate);

        (uint256 interestPaid, uint256 loanAmountPaid, uint256 accruedInterestAfter, ) =
            _splitInterestLoanPayment(
                amountToLiquidate,
                synthLoan.accruedInterest.add(interestAmount),
                synthLoan.loanAmount
            );

        // Send interests paid to fee pool and record loan amount paid
        _processInterestAndLoanPayment(interestPaid, loanAmountPaid);

        // Collateral value to redeem
        uint256 collateralRedeemed = exchangeRates().effectiveValue(oUSD, amountToLiquidate, "VBNB");

        // Add penalty
        uint256 totalCollateralLiquidated =
            collateralRedeemed.multiplyDecimal(SafeDecimalMath.unit().add(liquidationPenalty));

        // update remaining loanAmount less amount paid and update accrued interests less interest paid
        _updateLoan(synthLoan, synthLoan.loanAmount.sub(loanAmountPaid), accruedInterestAfter, block.timestamp);

        // update remaining collateral on loan
        _updateLoanCollateral(synthLoan, synthLoan.collateralAmount.sub(totalCollateralLiquidated));

        // Send liquidated VBNB collateral to msg.sender       
        IERC20(vToken).transfer(msg.sender, totalCollateralLiquidated.div((10**(OUSD_DECIMALS - VBNB_DECIMALS))));

        // emit loan liquidation event
        emit LoanPartiallyLiquidated(
            _loanCreatorsAddress,
            _loanID,
            msg.sender,
            amountToLiquidate,
            totalCollateralLiquidated
        );
    }

    function _splitInterestLoanPayment(
        uint256 _paymentAmount,
        uint256 _accruedInterest,
        uint256 _loanAmount
    )
        internal
        pure
        returns (
            uint256 interestPaid,
            uint256 loanAmountPaid,
            uint256 accruedInterestAfter,
            uint256 loanAmountAfter
        )
    {
        uint256 remainingPayment = _paymentAmount;

        // repay any accrued interests first
        accruedInterestAfter = _accruedInterest;
        if (remainingPayment > 0 && _accruedInterest > 0) {
            // Max repay is the accruedInterest amount
            interestPaid = remainingPayment > _accruedInterest ? _accruedInterest : remainingPayment;
            accruedInterestAfter = accruedInterestAfter.sub(interestPaid);
            remainingPayment = remainingPayment.sub(interestPaid);
        }

        // Remaining amounts - pay down loan amount
        loanAmountAfter = _loanAmount;
        if (remainingPayment > 0) {
            loanAmountAfter = loanAmountAfter.sub(remainingPayment);
            loanAmountPaid = remainingPayment;
        }
    }

    function _processInterestAndLoanPayment(uint256 interestPaid, uint256 loanAmountPaid) internal {
        // Fee distribution. Mint the oUSD fees into the FeePool and record fees paid
        if (interestPaid > 0) {
            synthoUSD().issue(address(this), interestPaid);
            //this will trigger record fees paid
            IERC20(address(synthoUSD())).transfer(FEE_ADDRESS, interestPaid);
        }

        // Decrement totalIssuedSynths
        if (loanAmountPaid > 0) {
            totalIssuedSynths = totalIssuedSynths.sub(loanAmountPaid);
        }
    }

    // Liquidation of an open loan available for anyone
    function liquidateUnclosedLoan(address _loanCreatorsAddress, uint256 _loanID) external nonReentrant VBNBRateNotInvalid {
        require(loanLiquidationOpen, "Liquidation is not open");
        // Close the creators loan and send collateral to the closer.
        _closeLoan(_loanCreatorsAddress, _loanID, true);
        // Tell the Dapps this loan was liquidated
        emit LoanLiquidated(_loanCreatorsAddress, _loanID, msg.sender);
    }

    // ========== PRIVATE FUNCTIONS ==========

    function _closeLoan(
        address account,
        uint256 loanID,
        bool liquidation
    ) private {
        systemStatus().requireIssuanceActive();

        // Get the loan from storage
        SynthLoanStruct memory synthLoan = _getLoanFromStorage(account, loanID);

        // Check loan exists and is open
        _checkLoanIsOpen(synthLoan);

        // Calculate and deduct accrued interest (5%) for fee pool
        // Accrued interests (captured in loanAmount) + new interests
        uint256 interestAmount =
            accruedInterestOnLoan(synthLoan.loanAmount.add(synthLoan.accruedInterest), _timeSinceInterestAccrual(synthLoan));
        uint256 repayAmount = synthLoan.loanAmount.add(interestAmount);

        uint256 totalAccruedInterest = synthLoan.accruedInterest.add(interestAmount);

        require(
            IERC20(address(synthoUSD())).balanceOf(msg.sender) >= repayAmount,
            "You do not have the required Synth balance to close this loan."
        );

        // Record loan as closed
        _recordLoanClosure(synthLoan);

        // Decrement totalIssuedSynths
        // subtract the accrued interest from the loanAmount
        totalIssuedSynths = totalIssuedSynths.sub(synthLoan.loanAmount.sub(synthLoan.accruedInterest));

        // Burn all Synths issued for the loan + the fees
        synthoUSD().burn(msg.sender, repayAmount);

        // Fee distribution. Mint the oUSD fees into the FeePool and record fees paid
        synthoUSD().issue(address(this), totalAccruedInterest);
        
        //this will trigger record fees paid
        IERC20(address(synthoUSD())).transfer(FEE_ADDRESS, totalAccruedInterest);

        uint256 remainingCollateral = synthLoan.collateralAmount;

        if (liquidation) {
            // Send liquidator redeemed collateral + 10% penalty
            uint256 collateralRedeemed = exchangeRates().effectiveValue(oUSD, repayAmount, "VBNB");

            // add penalty
            uint256 totalCollateralLiquidated =
                collateralRedeemed.multiplyDecimal(SafeDecimalMath.unit().add(liquidationPenalty));

            // ensure remaining VBNB collateral sufficient to cover collateral liquidated
            // will revert if the liquidated collateral + penalty is more than remaining collateral
            remainingCollateral = remainingCollateral.sub(totalCollateralLiquidated);

            // Send liquidator CollateralLiquidated
            IERC20(vToken).transfer(msg.sender, totalCollateralLiquidated);
        }

        // Send remaining collateral to loan creator
        uint256 scaled = remainingCollateral.div((10**(OUSD_DECIMALS - VBNB_DECIMALS)));
        IERC20(vToken).transfer(synthLoan.account, scaled);
        
        // Tell the Dapps
        emit LoanClosed(account, loanID, totalAccruedInterest);
    }

    function _getLoanFromStorage(address account, uint256 loanID) private view returns (SynthLoanStruct memory) {
        SynthLoanStruct[] memory synthLoans = accountsSynthLoans[account];
        for (uint256 i = 0; i < synthLoans.length; i++) {
            if (synthLoans[i].loanID == loanID) {
                return synthLoans[i];
            }
        }
    }

    function _updateLoan(
        SynthLoanStruct memory _synthLoan,
        uint256 _newLoanAmount,
        uint256 _newAccruedInterest,
        uint256 _lastInterestAccrued
    ) private {
        // Get storage pointer to the accounts array of loans
        SynthLoanStruct[] storage synthLoans = accountsSynthLoans[_synthLoan.account];
        for (uint256 i = 0; i < synthLoans.length; i++) {
            if (synthLoans[i].loanID == _synthLoan.loanID) {
                synthLoans[i].loanAmount = _newLoanAmount;
                synthLoans[i].accruedInterest = _newAccruedInterest;
                synthLoans[i].lastInterestAccrued = uint40(_lastInterestAccrued);
            }
        }
    }

    function _updateLoanCollateral(SynthLoanStruct memory _synthLoan, uint256 _newCollateralAmount)
        private
        returns (SynthLoanStruct memory)
    {
        // Get storage pointer to the accounts array of loans
        SynthLoanStruct[] storage synthLoans = accountsSynthLoans[_synthLoan.account];
        for (uint256 i = 0; i < synthLoans.length; i++) {
            if (synthLoans[i].loanID == _synthLoan.loanID) {
                synthLoans[i].collateralAmount = _newCollateralAmount;
                return synthLoans[i];
            }
        }
    }

    function _recordLoanClosure(SynthLoanStruct memory synthLoan) private {
        // Get storage pointer to the accounts array of loans
        SynthLoanStruct[] storage synthLoans = accountsSynthLoans[synthLoan.account];
        for (uint256 i = 0; i < synthLoans.length; i++) {
            if (synthLoans[i].loanID == synthLoan.loanID) {
                // Record the time the loan was closed
                synthLoans[i].timeClosed = block.timestamp;
            }
        }

        // Reduce Total Open Loans Count
        totalOpenLoanCount = totalOpenLoanCount.sub(1);
    }

    function _incrementTotalLoansCounter() private returns (uint256) {
        // Increase the total Open loan count
        totalOpenLoanCount = totalOpenLoanCount.add(1);
        // Increase the total Loans Created count
        totalLoansCreated = totalLoansCreated.add(1);
        // Return total count to be used as a unique ID.
        return totalLoansCreated;
    }

    function _calculateMintingFee(uint256 _loanAmount) private view returns (uint256 mintingFee) {
        mintingFee = _loanAmount.multiplyDecimalRound(issueFeeRate);
    }

    function _timeSinceInterestAccrual(SynthLoanStruct memory _synthLoan) private view returns (uint256 timeSinceAccrual) {
        // The last interest accrued timestamp for the loan
        // If lastInterestAccrued timestamp is not set (0), use loan timeCreated
        uint256 lastInterestAccrual =
            _synthLoan.lastInterestAccrued > 0 ? uint256(_synthLoan.lastInterestAccrued) : _synthLoan.timeCreated;

        // diff between last interested accrued and now
        // use loan's timeClosed if loan is closed
        timeSinceAccrual = _synthLoan.timeClosed > 0
            ? _synthLoan.timeClosed.sub(lastInterestAccrual)
            : block.timestamp.sub(lastInterestAccrual);
    }

    function _checkLoanIsOpen(SynthLoanStruct memory _synthLoan) internal pure {
        require(_synthLoan.loanID > 0, "Loan does not exist");
        require(_synthLoan.timeClosed == 0, "Loan already closed");
    }

    /* ========== INTERNAL VIEWS ========== */


    function systemStatus() internal view returns (ISystemStatus) {
        return ISystemStatus(resolver.requireAndGetAddress(CONTRACT_SYSTEMSTATUS, "Missing SystemStatus address"));
    }

    function synthoUSD() internal view returns (ISynth) {
        return ISynth(resolver.requireAndGetAddress(CONTRACT_SYNTHOUSD, "Missing ISynth"));
    }

    function exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(resolver.requireAndGetAddress(CONTRACT_EXRATES, "Missing IExchangeRates"));
    }

    function feePool() internal view returns (IFeePool) {
        return IFeePool(resolver.requireAndGetAddress(CONTRACT_FEEPOOL, "Missing IFeePool"));
    }

    function getVBNBValue(uint256 _amount) internal view returns (uint256) {
        return exchangeRates().effectiveValue("VBNB", _amount, "BNB");
    }

    function getBNBValue(uint256 _amount) internal view returns (uint256) {
        return exchangeRates().effectiveValue("BNB", _amount, "VBNB");
    }

    /* ========== MODIFIERS ========== */

    modifier VBNBRateNotInvalid() {
        require(!exchangeRates().rateIsStale(COLLATERAL), "Blocked as VBNB rate is invalid");
        _;
    }

    // ========== EVENTS ==========

    event CollateralizationRatioUpdated(uint256 ratio);
    event LiquidationRatioUpdated(uint256 ratio);
    event InterestRateUpdated(uint256 interestRate);
    event IssueFeeRateUpdated(uint256 issueFeeRate);
    event IssueLimitUpdated(uint256 issueLimit);
    event MinLoanCollateralSizeUpdated(uint256 minLoanCollateralSize);
    event AccountLoanLimitUpdated(uint256 loanLimit);
    event LoanLiquidationOpenUpdated(bool loanLiquidationOpen);
    event LoanCreated(address indexed account, uint256 loanID, uint256 amount);
    event LoanClosed(address indexed account, uint256 loanID, uint256 feesPaid);
    event LoanLiquidated(address indexed account, uint256 loanID, address liquidator);
    event LoanPartiallyLiquidated(
        address indexed account,
        uint256 loanID,
        address liquidator,
        uint256 liquidatedAmount,
        uint256 liquidatedCollateral
    );
    event CollateralDeposited(address indexed account, uint256 loanID, uint256 collateralAmount, uint256 collateralAfter);
    event CollateralWithdrawn(address indexed account, uint256 loanID, uint256 amountWithdrawn, uint256 collateralAfter);
    event LoanRepaid(address indexed account, uint256 loanID, uint256 repaidAmount, uint256 newLoanAmount);
}