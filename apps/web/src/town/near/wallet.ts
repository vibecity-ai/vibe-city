/* NEAR wallets in the browser (feature spec 6.1), through NEAR Wallet Selector: Meteor, HOT, MyNearWallet, Ledger.
   Loaded on demand (the safe), so the city itself stays light. Vibe City never sees keys: every transfer and every DAO
   proposal is shown to the user here first, then signed in their own wallet. */
import type { WalletSelector } from '@near-wallet-selector/core';
import type { WalletSelectorModal } from '@near-wallet-selector/modal-ui';
import type { NearNetwork } from '@vibe-city/shared';

const YOCTO = 10n ** 24n;
/** "1.5" NEAR to yoctoNEAR; null for anything that is not a positive amount with at most 24 decimals. */
export function parseNear(s: string): bigint | null {
  const m = /^\s*(\d+)(?:\.(\d{1,24}))?\s*$/.exec(s);
  if (!m) return null;
  const v = BigInt(m[1]!) * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
  return v > 0n ? v : null;
}
/** yoctoNEAR (decimal string or bigint) to a short NEAR amount. */
export function formatNear(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto), whole = v / YOCTO, frac = (v % YOCTO).toString().padStart(24, '0').slice(0, digits).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${frac ? '.' + frac : ''}`;
}

let current: { network: NearNetwork; selector: WalletSelector; modal: WalletSelectorModal } | null = null;

async function load(network: NearNetwork) {
  if (current?.network === network) return current;
  // The wallet libraries expect Node's Buffer; browsers do not have it.
  const g = globalThis as { Buffer?: unknown };
  if (!g.Buffer) g.Buffer = (await import('buffer')).Buffer;
  const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }, { setupHotWallet }, { setupLedger }] = await Promise.all([
    import('@near-wallet-selector/core'), import('@near-wallet-selector/modal-ui'), import('@near-wallet-selector/my-near-wallet'),
    import('@near-wallet-selector/meteor-wallet'), import('@near-wallet-selector/hot-wallet'), import('@near-wallet-selector/ledger'),
  ]);
  await import('@near-wallet-selector/modal-ui/styles.css');
  const selector = await setupWalletSelector({ network, modules: [setupMeteorWallet(), setupHotWallet(), setupMyNearWallet(), setupLedger()] });
  const modal = setupModal(selector, { theme: 'dark', description: 'Connect the NEAR wallet you will sign with. Vibe City only stores your public account id.' });
  current = { network, selector, modal };
  return current;
}

/** Signed-in account ids of the current wallet, as they change (including after a redirect back from a web wallet). */
export async function watchAccounts(network: NearNetwork, cb: (ids: string[]) => void): Promise<() => void> {
  const { selector } = await load(network);
  const sub = selector.store.observable.subscribe((st) => cb(st.accounts.map((a) => a.accountId)));
  return () => sub.unsubscribe();
}

export async function connect(network: NearNetwork) { (await load(network)).modal.show(); }

export async function disconnect(network: NearNetwork) {
  const { selector } = await load(network);
  if (selector.isSignedIn()) await (await selector.wallet()).signOut();
}

async function signer(network: NearNetwork, accountId: string) {
  const { selector } = await load(network);
  const signed = selector.store.getState().accounts.map((a) => a.accountId);
  if (!signed.includes(accountId)) throw new Error(`Sign in with ${accountId} first (Connect wallet).`);
  return { wallet: await selector.wallet(), core: await import('@near-wallet-selector/core') };
}

/** Sends NEAR from the user's account (e.g. a deposit into the DAO). The wallet shows and signs it. */
export async function sendNear(network: NearNetwork, from: string, to: string, yocto: bigint) {
  const { wallet, core } = await signer(network, from);
  return wallet.signAndSendTransaction({ signerId: from, receiverId: to, actions: [core.actionCreators.transfer(yocto)] });
}

/** Drafts a NEAR transfer proposal in a Sputnik DAO (add_proposal, with the DAO's proposal bond attached). The DAO's
    signers approve or reject it (in Trezu); nothing moves until they do. */
export async function proposeTransfer(network: NearNetwork, from: string, dao: string, receiver: string, yocto: bigint, description: string, bond: bigint) {
  const { wallet, core } = await signer(network, from);
  const proposal = { proposal: { description, kind: { Transfer: { token_id: '', receiver_id: receiver, amount: yocto.toString() } } } };
  return wallet.signAndSendTransaction({ signerId: from, receiverId: dao, actions: [core.actionCreators.functionCall('add_proposal', proposal, 100_000_000_000_000n, bond)] });
}
