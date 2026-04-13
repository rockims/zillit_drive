const ROLE_PRIORITY = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const hasMinRole = (role, minRole) => (ROLE_PRIORITY[role] || 0) >= (ROLE_PRIORITY[minRole] || 0);

const pickHigherRole = (roleA, roleB) =>
  (ROLE_PRIORITY[roleA] || 0) >= (ROLE_PRIORITY[roleB] || 0) ? roleA : roleB;

export {
  ROLE_PRIORITY,
  hasMinRole,
  pickHigherRole,
};
