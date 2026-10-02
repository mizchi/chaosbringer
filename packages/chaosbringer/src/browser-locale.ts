// Lives in lightbringer, whose own CLI needs it and which cannot import
// chaosbringer. See its doc there: a POSIX host gives `navigator.language`
// as `en-US@posix`, which is not a BCP 47 tag.
export { hostLocale } from "lightbringer/core";
