/**
 * Heuristic auth-form detection. Strategy:
 *
 * 1. Find every visible `input[type=password]` on the page.
 * 2. For each, walk up to the nearest `form` (or document body if
 *    formless) and look for sibling/descendant fields: a
 *    username/email-style input + a submit affordance.
 * 3. Classify login vs signup by:
 *      - URL hint (`/signup`, `/register`, `/join` → signup;
 *        `/login`, `/signin` → login)
 *      - presence of a confirm-password input (signup)
 *      - presence of additional fields like `name` (signup)
 *      - default: login (more common on a generic `/auth` URL)
 *
 * We deliberately don't try to be clever about i18n. If the page has
 * `<input type=password>` it's something we can attack. If we can't
 * find a submit button it isn't.
 */
import type { Locator, Page } from "playwright";
import type { AuthFormType, DetectedAuthForm } from "./types.js";

const USERNAME_HINT_RE = /user(name)?|email|login/i;
const SIGNUP_URL_RE = /signup|sign[-_]?up|register|join|create[-_]?account/i;
const LOGIN_URL_RE = /(^|\/)log[-_]?in|signin|sign[-_]?in/i;
const SIGNUP_TEXT_RE = /sign\s*up|create\s+account|register/i;
const LOGIN_TEXT_RE = /log\s*in|sign\s*in/i;
const RESET_URL_RE = /forgot|password[-_]?reset|reset[-_]?password|recover/i;
const RESET_TEXT_RE = /forgot.+password|reset.+password|password.+recovery/i;

export async function detectAuthForm(page: Page): Promise<DetectedAuthForm | null> {
  // Password-reset forms typically have NO password input — just an
  // email + submit. Try that path first when URL / page text hints at
  // a reset flow.
  const url = page.url();
  if (RESET_URL_RE.test(url)) {
    const reset = await detectPasswordResetForm(page);
    if (reset) return reset;
  }
  const passwordInputs = await page.locator('input[type="password"]:visible').all();
  if (passwordInputs.length === 0) {
    // No password input AND no URL hint. Try one more time: maybe the
    // page text gives the hint we need.
    const bodyText = await page.locator("body").innerText({ timeout: 500 }).catch(() => "");
    if (RESET_TEXT_RE.test(bodyText.slice(0, 4000))) {
      const reset = await detectPasswordResetForm(page);
      if (reset) return reset;
    }
    return null;
  }

  // Use the first visible password field. The classifier below decides
  // whether a SECOND password field hints at signup.
  const primaryPassword = passwordInputs[0]!;
  const formHandle = await primaryPassword.evaluateHandle((el) => {
    let cur: Element | null = el;
    while (cur && cur.tagName !== "FORM") cur = cur.parentElement;
    return cur ?? document.body;
  });
  const formId = await formHandle.evaluate((el: Element) => {
    if (el.id) return `#${cssEscape(el.id)}`;
    return null;
    function cssEscape(s: string) {
      return s.replace(/["\\]/g, "\\$&");
    }
  });
  // Scope subsequent queries to the form container. We use a Locator
  // for ergonomic chaining; if the form has no id we fall back to a
  // page-wide search (which is still scoped to visible elements).
  const formLocator = formId ? page.locator(formId).first() : page.locator("body");

  // Username/email field: first visible text/email input whose
  // name/id/placeholder/aria-label/autocomplete looks user-shaped.
  const candidateInputs = await formLocator
    .locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="button"])')
    .all();

  let usernameField: Locator | null = null;
  let emailField: Locator | null = null;
  for (const input of candidateInputs) {
    const info = await input.evaluate((el: Element) => {
      if (!(el instanceof HTMLInputElement)) return null;
      return {
        type: (el.type || "text").toLowerCase(),
        name: el.name,
        id: el.id,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute("aria-label") ?? "",
        autocomplete: el.autocomplete,
      };
    });
    if (!info) continue;
    const haystack = `${info.name} ${info.id} ${info.placeholder} ${info.ariaLabel} ${info.autocomplete}`;
    if (info.type === "email" && !emailField) emailField = input;
    if (USERNAME_HINT_RE.test(haystack) && !usernameField) usernameField = input;
  }
  // Fall back to the first text-like input we found.
  if (!usernameField && candidateInputs.length > 0) usernameField = candidateInputs[0]!;
  if (!usernameField) return null;

  const submitButton = await findSubmit(page, formLocator);
  if (!submitButton) return null;

  const confirmPasswordField = passwordInputs.length > 1 ? passwordInputs[1] : undefined;
  const type = classify({
    url: page.url(),
    confirmPasswordPresent: confirmPasswordField !== undefined,
    page,
  });

  return {
    type: await type,
    form: formLocator,
    usernameField,
    passwordField: primaryPassword,
    submitButton,
    ...(confirmPasswordField ? { confirmPasswordField } : {}),
    ...(emailField && emailField !== usernameField ? { emailField } : {}),
  };
}

async function findSubmit(page: Page, form: Locator): Promise<Locator | null> {
  // Priority 1: explicit submit affordance inside the form.
  const explicit = form.locator(
    'button[type="submit"]:visible, input[type="submit"]:visible',
  );
  if ((await explicit.count()) > 0) return explicit.first();
  // Priority 2: any button inside the form (some apps omit type=submit).
  const anyButton = form.locator("button:visible");
  if ((await anyButton.count()) > 0) return anyButton.first();
  // Priority 3: a button with login/signup-ish text anywhere on the page.
  const anywhere = page.getByRole("button", {
    name: /log\s*in|sign\s*in|sign\s*up|register|create\s+account/i,
  });
  if ((await anywhere.count()) > 0) return anywhere.first();
  return null;
}

async function classify(input: {
  url: string;
  confirmPasswordPresent: boolean;
  page: Page;
}): Promise<AuthFormType> {
  if (SIGNUP_URL_RE.test(input.url)) return "signup";
  if (LOGIN_URL_RE.test(input.url)) return "login";
  if (input.confirmPasswordPresent) return "signup";
  // Inspect page text for hints. Cap at 4KB to avoid pulling huge docs.
  const bodyText = await input.page
    .locator("body")
    .innerText({ timeout: 500 })
    .catch(() => "");
  const snippet = bodyText.slice(0, 4000);
  // Prefer signup when both phrases appear — login pages rarely say
  // "create account" but signup pages often link back to "log in".
  if (SIGNUP_TEXT_RE.test(snippet)) return "signup";
  if (LOGIN_TEXT_RE.test(snippet)) return "login";
  return "login";
}

/**
 * Password-reset form detection — used for the
 * `password-reset-token-entropy` attack (issue #93). Reset flows
 * typically have NO password input — just an email + submit — so the
 * primary detector won't find them.
 */
async function detectPasswordResetForm(page: Page): Promise<DetectedAuthForm | null> {
  const emailInput = page.locator('input[type="email"]:visible, input[name*="email" i]:visible').first();
  if ((await emailInput.count()) === 0) return null;
  const formLocator = page.locator("body");
  const submit = await findSubmit(page, formLocator);
  if (!submit) return null;
  // The driver expects passwordField to be defined. For reset forms
  // the field doesn't exist — use the email locator as a stand-in so
  // attack code that conditions on form.type doesn't have to special-case.
  return {
    type: "password-reset",
    form: formLocator,
    usernameField: emailInput,
    emailField: emailInput,
    passwordField: emailInput,
    submitButton: submit,
  };
}
