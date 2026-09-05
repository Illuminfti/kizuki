# Markdown source boundaries

Choose a source folder separate from the Kizuki vault. The folder connector
refuses a vault root, a child of a vault (including canon, archives and control
data), or a scan which encounters a nested vault. It recognizes the `.kizuki`
control marker before exclusions; an alias or dangling marker symlink does not
remove that boundary. Independent sibling source folders remain supported.

The refusal is `source_contains_kizuki_vault`. No batch is returned, no capture
checkpoint advances, and files hidden by the refusal are not tombstones. If a
previously enrolled source becomes a vault, sync refuses it until an independent
source is selected. This prevents Kizuki's own managed output entering that
same folder capture as new external evidence.

This folder boundary does not recognize generated text copied into a separate,
unmarked source, prove every file's authorship, or protect an independently
exported copy. Machine-origin content matching and hostile concurrent ancestor
replacement require separate ingress verification. Do not describe those cases
as qualified by the folder marker checks.
