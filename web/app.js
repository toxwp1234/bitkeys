const $ = (s) => document.querySelector(s);
const addr = $("#addr");
const go = $("#go");
const result = $("#result");

const fmtBtc = (n) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 8, maximumFractionDigits: 8 });
const fmtInt = (n) => n.toLocaleString("en-US");

const STATUS = {
  db:        { cls: "funded",  text: "Funded" },
  "db-fp":   { cls: "empty",   text: "Not funded" },
  bloom:     { cls: "empty",   text: "Not funded" },
  invalid:   { cls: "invalid", text: "Invalid address" },
};

function render(r) {
  const s = STATUS[r.source] || STATUS.bloom;
  const reason = {
    db: "found in database",
    "db-fp": "bloom false-positive, absent in database",
    bloom: "rejected by bloom filter (no disk read)",
    invalid: "failed checksum / format validation",
  }[r.source];

  result.innerHTML = `
    <div class="r-top">
      <span class="dot ${s.cls}"></span>
      <span class="r-status">${s.text}</span>
      <span class="badge ${r.source}" style="margin-left:auto">${r.source}</span>
    </div>
    <div class="r-addr">${escapeHtml(r.address)}</div>
    <div class="r-grid">
      <div class="cell"><div class="k">Balance</div><div class="v big">${r.funded ? fmtBtc(r.balance_btc) : "0.00000000"} <span style="font-size:12px;color:var(--muted)">BTC</span></div></div>
      <div class="cell"><div class="k">Satoshi</div><div class="v">${fmtInt(r.balance_sat)}</div></div>
      <div class="cell"><div class="k">Lookup</div><div class="v">${r.lookup_us.toFixed(1)} µs</div></div>
    </div>
    <p style="margin:16px 0 0;color:var(--muted);font-size:13px">${reason}</p>
  `;
  result.classList.remove("hidden", "enter");
  void result.offsetWidth;
  result.classList.add("enter");
  requestAnimationFrame(() => result.classList.remove("enter"));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function check() {
  const value = addr.value.trim();
  if (!value) return;
  go.disabled = true;
  try {
    const res = await fetch(`/api/check?address=${encodeURIComponent(value)}`);
    render(await res.json());
  } catch (e) {
    result.classList.remove("hidden");
    result.innerHTML = `<p style="color:var(--red);margin:0">Request failed: ${escapeHtml(String(e))}</p>`;
  } finally {
    go.disabled = false;
  }
}

go.addEventListener("click", check);
addr.addEventListener("keydown", (e) => { if (e.key === "Enter") check(); });
document.querySelectorAll(".chip").forEach((c) =>
  c.addEventListener("click", () => { addr.value = c.dataset.addr; check(); })
);

(async () => {
  try {
    const s = await (await fetch("/api/stats")).json();
    $("#stats").innerHTML =
      `<span><b>${fmtInt(s.funded_addresses)}</b> funded addresses</span>` +
      `<span>bloom <b>${s.bloom_size_mb} MB</b></span>` +
      `<span><b>${s.bloom_hashes}</b> hashes/lookup</span>`;
  } catch {}
})();
