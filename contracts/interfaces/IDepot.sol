pragma solidity >=0.4.24;


interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function synthsReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositSynths(uint amount) external;

    function exchangeEtherForSynths() external payable returns (uint);

    function exchangeEtherForSynthsAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedSynths() external;

    // Note: On mainnet no OKS has been deposited. The following functions are kept alive for testnet OKS faucets.
    function exchangeEtherForOKS() external payable returns (uint);

    function exchangeEtherForOKSAtRate(uint guaranteedRate, uint guaranteedOikosRate) external payable returns (uint);

    function exchangeSynthsForOKS(uint synthAmount) external returns (uint);

    function exchangeSynthsForOKSAtRate(uint synthAmount, uint guaranteedRate) external returns (uint);
}
