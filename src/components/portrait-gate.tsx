// Native no-op. The app is already portrait-locked here, properly, by the OS:
// app.json's `orientation: 'portrait'`. Nothing to gate.
//
// The real implementation is portrait-gate.web.tsx — see its header for why
// the web build cannot have the same thing.
export function PortraitGate() {
  return null;
}
