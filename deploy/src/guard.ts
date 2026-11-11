// Testnet only. A `TestnetAccount` cannot be built from a string that is not a `.testnet` account id, and an `Rpc`
// (rpc.ts) cannot be built for a node that does not report chain_id "testnet", so nothing in this package can sign or
// send for any other network: the checks are in the only constructors, not scattered through the callers.

declare const testnetAccountBrand: unique symbol;
export type TestnetAccount = string & { readonly [testnetAccountBrand]: true };

// NEAR account id grammar: 2..=64 characters, lowercase alphanumerics separated by single `.`, `-` or `_`.
const PART = "[a-z0-9]+(?:[-_][a-z0-9]+)*";
const TESTNET_ACCOUNT = new RegExp(`^(?:${PART}\\.)+testnet$`);

export function testnetAccount(id: string): TestnetAccount {
  if (id.length > 64 || !TESTNET_ACCOUNT.test(id)) {
    throw new Error(`refusing "${id.slice(0, 80)}": not a valid account id ending in .testnet (this tool is testnet only)`);
  }
  return id as TestnetAccount;
}

/** `sub.parent` for a sub-account of `parent`; the result is itself checked. */
export function subAccount(name: string, parent: TestnetAccount): TestnetAccount {
  return testnetAccount(`${name}.${parent}`);
}

export function assertTestnetChain(chainId: unknown): void {
  if (chainId !== "testnet") {
    throw new Error(`refusing to run: the RPC reports chain_id ${JSON.stringify(chainId)}, not "testnet" (this tool is testnet only)`);
  }
}
