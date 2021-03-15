pragma solidity 0.4.25;

import "../interfaces/IOikos.sol";


contract MockExchanger {
    uint256 private _mockReclaimAmount;
    uint256 private _mockRefundAmount;

    IOikos oikos;

    constructor(IOikos _oikos) public {
        oikos = _oikos;
    }

    // Mock settle function
    function settle(address from, bytes32 currencyKey) external view returns (uint256 reclaimed, uint256 refunded) {
        if (_mockReclaimAmount > 0) {
            oikos.synths(currencyKey).burn(from, _mockReclaimAmount);
        }

        if (_mockRefundAmount > 0) {
            oikos.synths(currencyKey).issue(from, _mockRefundAmount);
        }

        return (_mockReclaimAmount, _mockRefundAmount);
    }

    function settlementOwing(address account, bytes32 currencyKey)
        public
        view
        returns (uint reclaimAmount, uint rebateAmount)
    {
        return (_mockReclaimAmount, _mockRefundAmount);
    }

    function setReclaim(uint256 _reclaimAmount) external {
        _mockReclaimAmount = _reclaimAmount;
    }

    function setRefund(uint256 _refundAmount) external {
        _mockRefundAmount = _refundAmount;
    }
}
