# Guided review

Organize the supplied patch into chapters that explain the change to a reviewer new to the codebase.
Read the patch once. Group files by the behavior they implement and order the chapters by what the reader needs first.
Explain what changed, why it changed, and any limits the reviewer should check. This is an orientation to the diff.
Use plain words and short sentences. Name concrete files and functions when needed.
Place every changed file once, in a section's diffs or in unplacedFiles.
Each section has a title, an overview and a diffs array. Each diff names the exact file path and has a summary.
Return only the JSON requested by the supplied schema. The import command validates file coverage before opening the review.
