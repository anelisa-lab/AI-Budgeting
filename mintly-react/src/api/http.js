/**
 * Low-level HTTP transport for the AI-Budgeting FastAPI backend.
 *
 * This is the only file in the frontend that knows about `fetch`, headers,
 * status codes and FastAPI's error envelope. Nothing above it should ever
 * construct a Request by hand.
 *
 * WHY THIS FILE EXISTS IN THIS SHAPE
 * ----------------------------------
 * The backend is FastAPI (see AI-Budgeting-main/app). FastAPI does NOT use the
 * `{ message, errors }` envelope the old frontend contract assumed. It uses:
 *
 *   HTTPException      ->  { "detail": "Invalid email or password" }
 *   Pydantic 422       ->  { "detail": [ { "type": ..., "loc": ["body","email"],
 *                                          "msg": ..., "input": ... } ] }
 *
 * Every screen in this app renders errors from `error.message` and
 * `error.fieldErrors`, so the translation from FastAPI's shape into that shape
 * happens here, once, rather than in eight different screens.
 *
 * It is deliberately plain JavaScript with no imports: `tests/contract/run.mjs`
 * imports this module directly in Node to assert the exact requests it builds
 * against the real backend's routes.
 */

/* ------------------------------------------------------------------ config */

/**
 * The backend's own README starts it with:
 *   uvicorn app.main:app --reload --port 4000
 * ...and app/main.py mounts every router at the ROOT (no `/api` prefix).
 * So the default here is the backend's real default, not an invented one.
 *
 * Override per-environment in `.env.local` with VITE_API_BASE_URL.
 */
export const DEFAULT_API_BASE_URL = 'http://localhost:4000';

/**
 * Read the configured base URL.
 *
 * `import.meta.env.VITE_API_BASE_URL` is written out IN FULL and statically,
 * deliberately: Vite only substitutes that exact literal form at build time.
 * A dynamic lookup — import.meta.env[someKey] — works in `npm run dev` and
 * then comes back undefined in `npm run build`, which is a bug that only
 * appears in the production bundle.
 *
 * The try/catch and the process.env branch let plain Node import this module
 * (tests/contract/run.mjs does), where import.meta.env does not exist.
 */
function configuredBaseUrl() {
  let fromVite;
  try {
    fromVite = import.meta.env?.VITE_API_BASE_URL;
  } catch {
    fromVite = undefined;
  }
  if (fromVite) return fromVite;

  if (typeof process !== 'undefined' && process.env?.VITE_API_BASE_URL) {
    return process.env.VITE_API_BASE_URL;
  }
  return DEFAULT_API_BASE_URL;
}

export const API_BASE_URL = String(configuredBaseUrl()).replace(/\/+$/, '');

/** Shown in the nav so it is never a mystery which backend a demo is on. */
export const API_ORIGIN_LABEL = API_BASE_URL;

/* ------------------------------------------------------------ field naming */

/**
 * Backend field name -> the id of the form field that collects it.
 *
 * The backend is the source of truth for what is SENT. This map exists only so
 * that a 422 about `total_amount` highlights the input the student typed into,
 * which is labelled "How much did you receive?" and has id="amount".
 */
export const BACKEND_FIELD_TO_FORM_FIELD = {
  name: 'name',
  email: 'email',
  password: 'password',
  total_amount: 'amount',
  cycle_start_date: 'payoutDate',
  cycle_end_date: 'periodDays',
  savings_percentage: 'savingsPercentage',
  budget_kind: 'budgetKind',
  item_name: 'description',
  amount: 'amount',
  category: 'category',
  is_essential: 'isEssential',
};

/* -------------------------------------------------------------- 401 hookup */

let onUnauthorized = null;

/**
 * AuthContext registers here so that ANY expired/invalid token anywhere in the
 * app clears the session once, instead of each screen inventing its own
 * handling. Called for 401s only.
 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = typeof handler === 'function' ? handler : null;
}

/* ----------------------------------------------------------- error mapping */

export class ApiError extends Error {
  constructor(message, { status = 0, fieldErrors = null, detail = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fieldErrors = fieldErrors;
    this.detail = detail;
  }
}

/** Turn FastAPI's 422 `detail` array into { formFieldId: message }. */
function fieldErrorsFrom422(detail) {
  if (!Array.isArray(detail)) return null;
  const out = {};
  for (const item of detail) {
    const loc = Array.isArray(item?.loc) ? item.loc : [];
    // loc looks like ["body", "email"] or ["query", "limit"]; the last entry
    // is the field itself.
    const backendField = String(loc[loc.length - 1] ?? '');
    const formField = BACKEND_FIELD_TO_FORM_FIELD[backendField] || backendField;
    if (!formField) continue;
    if (!out[formField]) out[formField] = humaniseValidationMessage(item?.msg, backendField);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Pydantic messages are developer-facing ("Input should be a valid email
 * address"). The rubric asks for messages that tell a student how to fix the
 * problem, so the handful we can predictably hit get a student-facing rewrite;
 * anything else falls through to Pydantic's own wording rather than being
 * swallowed.
 */
function humaniseValidationMessage(msg, backendField) {
  const raw = String(msg || 'This value is not valid.');
  if (/valid email/i.test(raw)) {
    return 'Enter a valid email address, like s221234567@dut4life.ac.za';
  }
  if (/greater than 0/i.test(raw) && backendField === 'total_amount') {
    return 'Your allowance must be more than R0.';
  }
  if (/greater than 0/i.test(raw) && backendField === 'amount') {
    return 'Enter an amount greater than R0.';
  }
  if (/valid date/i.test(raw)) {
    return 'Choose a valid date.';
  }
  if (/field required/i.test(raw) || /Field required/.test(raw)) {
    return 'This field is required.';
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Build an ApiError from a non-2xx response body.
 *
 * `fieldHints` lets a caller say "if this request 401s, the problem belongs on
 * the password field" — which is how the login screen puts a server-side
 * rejection under the right input rather than in a page-level banner.
 */
export function toApiError(status, payload, fieldHints = {}) {
  const detail = payload && typeof payload === 'object' ? payload.detail : null;

  if (status === 422 && Array.isArray(detail)) {
    return new ApiError('Some details need fixing before this can be saved.', {
      status,
      fieldErrors: fieldErrorsFrom422(detail),
      detail,
    });
  }

  const message =
    (typeof detail === 'string' && detail) ||
    (payload && typeof payload.message === 'string' && payload.message) ||
    fallbackMessage(status);

  const hinted = fieldHints[status];
  const fieldErrors = hinted ? { [hinted]: message } : null;

  return new ApiError(message, { status, fieldErrors, detail });
}

function fallbackMessage(status) {
  switch (status) {
    case 400: return 'That request could not be processed. Check the details and try again.';
    case 401: return 'Your session has expired. Please sign in again.';
    case 403: return 'You do not have permission to do that.';
    case 404: return 'We could not find that.';
    case 409: return 'That conflicts with something that already exists.';
    case 500: return 'The server had a problem. Try again in a moment.';
    default:  return `Request failed (${status}).`;
  }
}

/* --------------------------------------------------------------- the call */

/**
 * @param {string} path      Path on the backend, exactly as FastAPI mounts it.
 * @param {object} options
 * @param {string} options.method
 * @param {object} options.body    JSON body (omitted entirely when undefined)
 * @param {object} options.query   Query params; null/undefined/'' are dropped
 * @param {string} options.token   Bearer token for protected routes
 * @param {object} options.fieldHints  status -> form field id
 * @param {Function} options.fetchImpl Injected for tests
 */
export async function request(path, {
  method = 'GET',
  body,
  query,
  token,
  fieldHints,
  fetchImpl,
  signal,
} = {}) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new ApiError('No fetch implementation available.', { status: 0 });

  const url = `${API_BASE_URL}${path}${buildQuery(query)}`;

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  // The backend uses HTTPBearer (app/dependencies.py), so the scheme is
  // literally "Bearer" — not "Token", not a cookie, not a session.
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(
      'Could not reach the server. Check that the backend is running and try again.',
      { status: 0 },
    );
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null;

  if (!response.ok) {
    if (response.status === 401 && onUnauthorized) onUnauthorized();
    throw toApiError(response.status, payload, fieldHints || {});
  }

  return payload;
}

/** Drop empty params so the backend gets its own defaults rather than "". */
export function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') {
      params.set(key, value ? 'true' : 'false');
      continue;
    }
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
