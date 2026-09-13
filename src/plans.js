'use strict';

const LIMITS = {
  free: 3,
  pro: Number.POSITIVE_INFINITY,
};

function searchLimit(plan) {
  return LIMITS[plan] ?? LIMITS.free;
}

function isPro(plan) {
  return plan === 'pro';
}

function canExport(plan) {
  return isPro(plan);
}

function canBatch(plan) {
  return isPro(plan);
}

function remainingSlots(plan, count) {
  const limit = searchLimit(plan);
  if (!Number.isFinite(limit)) return Infinity;
  return Math.max(0, limit - count);
}

module.exports = { LIMITS, searchLimit, isPro, canExport, canBatch, remainingSlots };
