import { hash } from "./core.ts";
/** Namespace memory per configured account; provider requests still verify that account. */
export async function localOwnerNamespace(ownerUrn: string | undefined) {
  if (!ownerUrn) return "local:unconnected";
  if (!/^urn:li:[A-Za-z]+:[^\s]{1,180}$/.test(ownerUrn))
    throw new Error("Invalid LinkedIn owner identity");
  return "local:" + (await hash(ownerUrn));
}
