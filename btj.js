import {
  Connection,
  PublicKey,
  clusterApiUrl
} from "https://esm.sh/@solana/web3.js"

const BTJ_MINT = new PublicKey(
  "BHwwhu2Rz9toxBNKtD8bTY8XDWbh51PSHnH7nfUNUCHR"
)

const connection = new Connection(
  clusterApiUrl("mainnet-beta"),
  "confirmed"
)

const walletEl = document.getElementById("wallet")
const btjEl = document.getElementById("btj")
const btn = document.getElementById("connect")

btn.onclick = async () => {
  if (!window.solana || !window.solana.isPhantom) {
    alert("Nainstaluj Phantom peněženku")
    return
  }

  const resp = await window.solana.connect()
  const publicKey = resp.publicKey

  walletEl.textContent =
    "Wallet: " +
    publicKey.toBase58().slice(0, 6) +
    "..." +
    publicKey.toBase58().slice(-4)

  const tokens =
    await connection.getParsedTokenAccountsByOwner(
      publicKey,
      {
        programId: new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        )
      }
    )

  let found = false

  for (const acc of tokens.value) {
    const info = acc.account.data.parsed.info

    if (info.mint === BTJ_MINT.toBase58()) {
      btjEl.textContent =
        "🪙 BTJ balance: " +
        info.tokenAmount.uiAmount
      found = true
      break
    }
  }

  if (!found) {
    btjEl.textContent =
      "❌ BTJ token není v peněžence"
  }
}
