const IDENTITY_USER_KEY = 'ralph.ui.identity.user';
const IDENTITY_ROLE_KEY = 'ralph.ui.identity.role';
const VALID_ROLES = ['viewer', 'operator', 'reviewer', 'admin'];

export function loadIdentity() {
  const userId = String(window.localStorage.getItem(IDENTITY_USER_KEY) ?? '').trim();
  const roleRaw = String(window.localStorage.getItem(IDENTITY_ROLE_KEY) ?? 'viewer').trim();
  const role = VALID_ROLES.includes(roleRaw) ? roleRaw : 'viewer';
  return { userId, role };
}

export function saveIdentity(identity) {
  const userId = String(identity.userId ?? '').trim();
  const role = VALID_ROLES.includes(identity.role) ? identity.role : 'viewer';

  if (!userId) {
    window.localStorage.removeItem(IDENTITY_USER_KEY);
  } else {
    window.localStorage.setItem(IDENTITY_USER_KEY, userId);
  }
  window.localStorage.setItem(IDENTITY_ROLE_KEY, role);

  return { userId, role };
}

export function clearIdentity() {
  window.localStorage.removeItem(IDENTITY_USER_KEY);
  window.localStorage.removeItem(IDENTITY_ROLE_KEY);
}

export function authHeaders(identity) {
  if (!identity?.userId) {
    return {};
  }
  return {
    'x-ralph-user': identity.userId,
    'x-ralph-roles': identity.role,
  };
}

export function canPerformAction(me, action) {
  if (!me?.authenticated) {
    return false;
  }
  return Array.isArray(me.permissions?.actions) && me.permissions.actions.includes(action);
}

export function summarizeAuth(me) {
  if (!me) {
    return 'auth: --';
  }
  if (!me.authenticated) {
    return 'auth: anonymous viewer';
  }
  return `auth: ${me.user_id} (${me.roles.join(',')})`;
}
