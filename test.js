const solc = require('solc')
const fs = require('fs')

const CONTRACT_FILE = 'contracts/BNBCollateral.sol'

const content = fs.readFileSync(CONTRACT_FILE).toString()

const input = {
  language: 'Solidity',
  sources: {
    [CONTRACT_FILE]: {
      content: content
    }
  },
  settings: {
    outputSelection: {
      '*': {
        '*': ['*']
      }
    }
  }
}

const output = JSON.parse(solc.compile(JSON.stringify(input)))

for (const contractName in output.contracts[CONTRACT_FILE]) {
  console.log(output.contracts[CONTRACT_FILE][contractName].evm.bytecode.object)
}
