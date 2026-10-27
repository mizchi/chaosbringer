import { definePattern, html, json, page, raw } from "../pattern.js";

// A login is user input, and one member chose "__proto__". The team endpoint
// keys post counts by login, so its JSON has an own "__proto__" key (served
// with raw(): json() would stringify an object literal, where the key sets the
// prototype and is dropped). JSON.parse keeps it as an own key, Object.hasOwn
// reads only own keys, and object spread copies it as an own key, so nothing
// reaches Object.prototype. A feature flag that shares the canary's name,
// cbPolluted, is an own key on a plain object and says nothing either.
const body = `<h1>Team activity</h1>
<h2>Members</h2>
<ul id="members"><li>Loading…</li></ul>
<h2>Feature flags</h2>
<ul id="flags"><li>Loading…</li></ul>
<script>
    const defaults = { cbPolluted: false, compactList: true };
    const item = (text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    };
    async function load() {
      const [team, flags] = await Promise.all([
        fetch("/api/team").then((res) => res.json()),
        fetch("/api/flags").then((res) => res.json()),
      ]);
      // A login like "constructor" has no own count and must not read Object's.
      const posts = (login) => (Object.hasOwn(team.posts, login) ? team.posts[login] : 0);
      document.getElementById("members").replaceChildren(
        ...team.members.map((m) => item(m.name + " (@" + m.login + "): " + posts(m.login) + " posts")),
      );
      const effective = { ...defaults, ...flags };
      document.getElementById("flags").replaceChildren(
        ...Object.entries(effective).map(([name, on]) => item(name + ": " + (on ? "on" : "off"))),
      );
    }
    load();
</script>`;

export default definePattern({
  id: "oracle-own-keys",
  title: "A member named __proto__ and a flag named cbPolluted",
  category: "oracle",
  description:
    'The team page lists members with their post counts and the feature flags. One member\'s login and display name is "__proto__", so the counts object the API sends has an own "__proto__" key; another login is "constructor", which has no count. A flag is named cbPolluted, the canary\'s own name, and the page spreads the flags over its defaults. A check that looked for the canary name or a "__proto__" key in the data, rather than on Object.prototype, would flag this page.',
  fix: "Nothing to fix: prototypePollution reads Object.prototype's enumerable keys, not the keys of objects the page holds.",
  realism: "Usernames, tags and dictionary keys chosen by users (__proto__, constructor); maps keyed by user input; flags and settings objects merged by spread.",
  routes: () => ({
    "/": html(page("Team activity", body)),
    "/api/team": raw(
      '{"members":[{"login":"ada","name":"Ada"},{"login":"__proto__","name":"__proto__"},{"login":"constructor","name":"Con Structor"}],"posts":{"ada":12,"__proto__":3}}',
      "application/json",
    ),
    "/api/flags": json({ cbPolluted: true, betaSearch: false }),
  }),
  inject: { channel: "none" },
  expect: { signal: "none" },
});
