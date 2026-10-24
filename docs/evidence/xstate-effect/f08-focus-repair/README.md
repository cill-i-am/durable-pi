# Passkey editor focus recovery

Hosted browser checks for #220 (40117051707) and #221 (40118091871) exposed an intermittent failure after cancelling passkey removal: the Remove button received focus, then the native Drawer restored focus to its popup on the following animation frame.

The required passkey journey now performs six open/cancel cycles at 6× CPU throttling and checks focus after two animation frames, keeping the original five-second assertion deadline. It failed against the previous production build (`regression-before.txt`) and passed against the repaired build (`regression-after.txt`). The wrong-origin authentication error in the passing log is the existing expected negative control.

The component restores focus after the bounded native restoration only while its actor remains active, the editor stays closed, the target remains enabled and connected, and focus has not moved to another control. Effect cleanup cancels the pending frame. Type checking and targeted lint also passed. Earlier publication manifests remain historical source freezes; this additive manifest identifies the two repaired files. Hosted checks for the new commits are a separate gate.
