// Test preload (--require): delivers SIGTERM to THIS process after a delay taken from
// the environment. Windows cannot deliver signals to a child process (child.kill("SIGTERM")
// is TerminateProcess), so the bridge emits INSIDE the serve process and the real
// handlers run. With no listener registered yet, the OS default is emulated honestly:
// terminate with 143 (the round-48 SRE methodology).
const delay = Number(process.env.LOTWISE_TEST_SIGTERM_AFTER_MS ?? 0);
if (delay > 0) {
  setTimeout(() => {
    if (process.listenerCount("SIGTERM") > 0) {
      process.emit("SIGTERM");
    } else {
      console.log("[sigterm-bridge] no SIGTERM listener — default-terminate (143)");
      process.exit(143);
    }
  }, delay).unref();
}
