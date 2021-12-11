pragma solidity >=0.5.0;

interface IVBNB {
    function mint() external payable;
    function transfer(address to, uint value) external returns (bool);
    function balanceOf(address owner) external view returns (uint);
    function borrow(uint borrowAmount) external returns (uint);
    function repayBorrow() external payable;
    function redeem(uint redeemTokens) external returns (uint);
    function borrowBalanceStored(address account) external view returns (uint);

}