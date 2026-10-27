import { definePattern, html, json, page } from "../pattern.js";

// A contact page full of URLs that aren't pages: placeholder javascript:
// hrefs and a javascript: form action whose handlers do the work, and the
// mailto: and tel: links of every office, some written by the server and some
// by the page from an API answer. None names a marker, so injectedMarkup has
// nothing to report; with anyJavascriptUrl it reports every placeholder.
const body = `<header>
  <a href="javascript:void(0)" id="menu-toggle" aria-controls="menu" aria-expanded="false">Menu</a>
  <nav id="menu" hidden><a href="/">Contact</a></nav>
</header>
<h1>Contact us</h1>
<p>Write to <a href="mailto:support@example.test?subject=Order%20question">support@example.test</a> or call <a href="tel:+15550100">+1 555 0100</a>.</p>
<p><a href="JavaScript:void(0);" id="hours-toggle">Opening hours</a></p>
<p id="hours" hidden>Monday to Friday, 9:00 to 17:00.</p>
<h2>Offices</h2>
<ul id="offices"><li>Loading…</li></ul>
<form action="javascript:;" id="callback">
  <label for="phone">Your number</label>
  <input id="phone" name="phone" type="tel" autocomplete="tel">
  <button type="submit">Call me back</button>
</form>
<p id="callback-status"></p>
<script>
    // The hrefs are placeholders that make the elements focusable; each
    // handler does the work.
    const toggle = (link, target) =>
      link.addEventListener("click", (event) => {
        event.preventDefault();
        target.hidden = !target.hidden;
        link.setAttribute("aria-expanded", String(!target.hidden));
      });
    toggle(document.getElementById("menu-toggle"), document.getElementById("menu"));
    toggle(document.getElementById("hours-toggle"), document.getElementById("hours"));
    document.getElementById("callback").addEventListener("submit", (event) => {
      event.preventDefault();
      document.getElementById("callback-status").textContent = "We will call you back.";
    });

    const offices = document.getElementById("offices");
    async function load() {
      const res = await fetch("/api/offices");
      const list = await res.json();
      offices.replaceChildren(
        ...list.map((office) => {
          const li = document.createElement("li");
          const call = document.createElement("a");
          call.href = "tel:" + office.phone.replace(/[^+\\d]/g, "");
          call.textContent = office.phone;
          const mail = document.createElement("a");
          mail.href = "mailto:" + office.email;
          mail.textContent = office.email;
          li.append(office.city + ": ", call, " · ", mail);
          return li;
        }),
      );
    }
    load();
</script>`;

export default definePattern({
  id: "oracle-safe-links",
  title: "Placeholder javascript: links next to mailto: and tel:",
  category: "oracle",
  description:
    "The contact page's menu and opening-hours toggles are links with href=\"javascript:void(0)\" (one written JavaScript:void(0);) and its call-back form has action=\"javascript:;\", all with a handler that does the work; the office list puts mailto: and tel: links on the page from an API answer. A check that flagged every javascript: URL, or every URL that isn't http(s), would flag most hand-written sites.",
  fix: "Nothing to fix: injectedMarkup counts a javascript: URL only when it names a marker, and never a mailto: or tel: link.",
  realism: "Hamburger menus and toggles from the jQuery era, forms submitted by a handler, contact footers and office lists.",
  routes: () => ({
    "/": html(page("Contact us", body)),
    "/api/offices": json([
      { city: "Berlin", phone: "+49 30 5550 1234", email: "berlin@example.test" },
      { city: "Osaka", phone: "+81 6 5550 1234", email: "osaka@example.test" },
    ]),
  }),
  inject: { channel: "none" },
  expect: { signal: "none" },
});
