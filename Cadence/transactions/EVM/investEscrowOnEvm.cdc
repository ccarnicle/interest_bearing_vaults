import "EVM"

// DFSEscrowManager mainnet: 0x97a582e24B6a68a4D654421D46c89B9923F1Fd40
// Calls investEscrowFunds(uint256) on DFSEscrowManager via the signer's COA.
transaction(escrowId: UInt256, escrowManagerAddress: String) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount
  let callData: [UInt8]

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("Could not borrow reference to the COA")

    self.callData = EVM.encodeABIWithSignature(
      "investEscrowFunds(uint256)",
      [escrowId]
    )
  }

  execute {
    let result = self.coa.call(
      to: EVM.addressFromString(escrowManagerAddress),
      data: self.callData,
      gasLimit: 500_000,
      value: EVM.Balance(attoflow: 0)
    )
    assert(
      result.status == EVM.Status.successful,
      message: "investEscrowFunds failed"
    )
  }
}
