function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info: (...args) => console.log(stamp(), "INFO ", ...args),
  warn: (...args) => console.warn(stamp(), "WARN ", ...args),
  error: (...args) => console.error(stamp(), "ERROR", ...args),
};
