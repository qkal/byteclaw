import HOST_ENV_SECURITY_POLICY_JSON from "./host-env-security-policy.json" with { type: "json" };

function sortUniqueUppercase(values) {
  return Object.freeze(
    [...new Set(values.map((value) => value.toUpperCase()))].toSorted((a, b) => a.localeCompare(b)),
  );
}

function derivePolicyArrays(policy) {
  const blockedEverywhereKeys = policy.blockedEverywhereKeys ?? [];
  const blockedOverrideOnlyKeys = policy.blockedOverrideOnlyKeys ?? [];
  const allowedInheritedOverrideOnlyKeys = policy.allowedInheritedOverrideOnlyKeys ?? [];
  const allowedInheritedOverrideOnlyUpper = new Set(
    allowedInheritedOverrideOnlyKeys.map((value) => value.toUpperCase()),
  );
  const blockedPrefixes = policy.blockedPrefixes ?? [];
  const blockedOverridePrefixes = policy.blockedOverridePrefixes ?? [];
  const blockedInheritedPrefixes = policy.blockedInheritedPrefixes ?? blockedPrefixes;

  return {
    blockedInheritedKeys: sortUniqueUppercase([
      ...blockedEverywhereKeys,
      ...blockedOverrideOnlyKeys.filter(
        (value) => !allowedInheritedOverrideOnlyUpper.has(value.toUpperCase()),
      ),
    ]),
    blockedInheritedPrefixes: sortUniqueUppercase(blockedInheritedPrefixes),
    blockedKeys: sortUniqueUppercase(blockedEverywhereKeys),
    blockedOverrideKeys: sortUniqueUppercase(blockedOverrideOnlyKeys),
    blockedOverridePrefixes: sortUniqueUppercase(blockedOverridePrefixes),
    blockedPrefixes: sortUniqueUppercase(blockedPrefixes),
  };
}

export function loadHostEnvSecurityPolicy(rawPolicy = HOST_ENV_SECURITY_POLICY_JSON) {
  const derived = derivePolicyArrays(rawPolicy);
  return Object.freeze({
    allowedInheritedOverrideOnlyKeys: Object.freeze(
      rawPolicy.allowedInheritedOverrideOnlyKeys ?? [],
    ),
    blockedEverywhereKeys: Object.freeze(rawPolicy.blockedEverywhereKeys ?? []),
    blockedInheritedKeys: derived.blockedInheritedKeys,
    blockedInheritedPrefixes: derived.blockedInheritedPrefixes,
    blockedKeys: derived.blockedKeys,
    blockedOverrideKeys: derived.blockedOverrideKeys,
    blockedOverrideOnlyKeys: Object.freeze(rawPolicy.blockedOverrideOnlyKeys ?? []),
    blockedOverridePrefixes: derived.blockedOverridePrefixes,
    blockedPrefixes: derived.blockedPrefixes,
  });
}

export const HOST_ENV_SECURITY_POLICY = loadHostEnvSecurityPolicy();
