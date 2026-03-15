import "EVM"

/// Reads getActiveEscrowIds() from DFSEscrowManager on EVM and logs the result.
/// Use this to verify ABI encoding/decoding before deploying DFSEscrowInvestor.
///
/// DFSEscrowManager mainnet: 0x97a582e24B6a68a4D654421D46c89B9923F1Fd40
///
/// Usage:
///   flow transactions send cadence/transactions/EVM/readActiveEscrowIdsFromEvm.cdc \
///     --network mainnet --signer frontend-agent \
///     --args-json '[{"type":"String","value":"0x97a582e24B6a68a4D654421D46c89B9923F1Fd40"}]'
transaction(escrowManagerAddress: String) {
  let coa: auth(EVM.Call) &EVM.CadenceOwnedAccount

  prepare(signer: auth(BorrowValue) &Account) {
    self.coa = signer.storage.borrow<auth(EVM.Call) &EVM.CadenceOwnedAccount>(
      from: /storage/evm
    ) ?? panic("Could not borrow reference to the COA")
  }

  execute {
    let getIdsCallData = EVM.encodeABIWithSignature("getActiveEscrowIds()", [])
    let result = self.coa.call(
      to: EVM.addressFromString(escrowManagerAddress),
      data: getIdsCallData,
      gasLimit: 1_000_000,
      value: EVM.Balance(attoflow: 0)
    )

    if result.status != EVM.Status.successful {
      log("EVM call failed")
      return
    }

    let decoded = EVM.decodeABI(types: [Type<[UInt256]>()], data: result.data) as! [AnyStruct]
    let activeIds = decoded[0] as! [UInt256]

    log("getActiveEscrowIds() returned ".concat(activeIds.length.toString()).concat(" escrow(s)"))
    var i = 0
    while i < activeIds.length {
      log("  escrowId[".concat(i.toString()).concat("]: ").concat(activeIds[i].toString()))
      i = i + 1
    }
  }
}
