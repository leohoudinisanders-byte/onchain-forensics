/* Token-page watch box for onchainforensics.dev/t/*
   Free tier of the alert engine: one email, up to three contracts, one digest a day.
   The page supplies the contract and symbol; this file renders the form, styles it to
   match the dark token pages, and posts to the free alerts route. No dependencies. */
(function () {
  // View counter (Nov 17, 2026): fire-and-forget, once per tab session, never blocks the form.
  try {
    if (!sessionStorage.getItem("ofv1")) {
      sessionStorage.setItem("ofv1", "1");
      var bq = "https://solene-fa2010da.base44.app/functions/pageBeacon?k=token&p=" +
        encodeURIComponent(location.pathname) + "&r=" +
        encodeURIComponent(document.referrer ? (document.referrer.split("/")[2] || "") : "");
      fetch(bq, { method: "GET", keepalive: true, mode: "cors" }).catch(function () {});
    }
  } catch (e) {}

  var API = "https://solene-fa2010da.base44.app/functions/alertsFree";
  var mount = document.getElementById("token-watch");
  if (!mount) return;
  var address = (mount.getAttribute("data-address") || "").trim();
  var symbol = (mount.getAttribute("data-symbol") || "this token").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return;

  var css = document.createElement("style");
  css.textContent = [
    "#token-watch{margin:26px 0}",
    "#token-watch .wbx{border:1px solid #2f3a46;border-left:3px solid #4ade80;border-radius:12px;padding:18px 20px;background:#131922}",
    "#token-watch p{margin:0 0 12px}",
    "#token-watch .wk{font-size:16px}",
    "#token-watch form{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 8px}",
    "#token-watch input[type=email]{flex:1 1 240px;min-width:0;padding:11px 13px;border-radius:8px;border:1px solid #2f3a46;background:#0e1116;color:#e8ecf1;font:inherit;font-size:15px}",
    "#token-watch input[type=email]:focus{outline:2px solid #4ade80;outline-offset:1px}",
    "#token-watch button{padding:11px 18px;border-radius:8px;border:none;background:#4ade80;color:#08210f;font:inherit;font-weight:600;cursor:pointer}",
    "#token-watch button:disabled{opacity:.6;cursor:default}",
    "#token-watch .wm{font-size:14px;color:#93a0af}",
    "#token-watch .wm.ok{color:#4ade80}",
    "#token-watch .wm.err{color:#f87171}",
    "#token-watch .wf{font-size:13px;color:#93a0af;margin:0}",
    "#token-watch code{font-size:13px}"
  ].join("\n");
  document.head.appendChild(css);

  var short = symbol.length > 14 ? symbol.slice(0, 14) + "..." : symbol;
  mount.innerHTML =
    '<div class="wbx">' +
      '<p class="wk"><b>Watch ' + short + " free.</b> One email a day if its grade drops. No card, no account, three contracts covered.</p>" +
      '<form novalidate>' +
        '<input type="email" placeholder="you@example.com" required autocomplete="email" aria-label="Your email address">' +
        '<button type="submit">Watch ' + short + "</button>" +
      "</form>" +
      '<p class="wm" role="status"></p>' +
      '<p class="wf">Need fifty contracts and same-day mail when a grade drops? <a href="/alerts.html">$29 for 30 days</a>. Or feed the whole grade-change stream to an agent: <a href="/alerts-feed.html">public feed</a>.</p>' +
    "</div>";

  var form = mount.querySelector("form");
  var input = mount.querySelector("input[type=email]");
  var btn = mount.querySelector("button");
  var msg = mount.querySelector(".wm");

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = (input.value || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$/.test(email)) {
      msg.className = "wm err";
      msg.textContent = "That does not look like an email address.";
      return;
    }
    btn.disabled = true;
    msg.className = "wm";
    msg.textContent = "Adding you...";
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, watchlist: [address] })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !(res.j && res.j.alerts_key) && !(res.j && res.j.already_subscribed)) {
          msg.className = "wm err";
          msg.textContent = (res.j && (res.j.detail || res.j.error)) || "That did not go through. Try again in a moment.";
          btn.disabled = false;
          return;
        }
        form.style.display = "none";
        if (res.j.already_subscribed) {
          msg.className = "wm ok";
          msg.textContent = "You already have a paid subscription, so it picked up 7 extra days. " + short + " is on the list.";
        } else {
          msg.className = "wm ok";
          msg.innerHTML = "You are watching " + short + ". Keep this key; it is the only handle to your watch:<br><code>" + res.j.alerts_key + "</code><br>The first digest lands at 07:00 America/Chicago, and only if something changed.";
        }
      })
      .catch(function () {
        msg.className = "wm err";
        msg.textContent = "Network error. The endpoint is live; try once more.";
        btn.disabled = false;
      });
  });
})();
