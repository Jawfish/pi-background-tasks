// Tests must never write the user's real task journal.
process.env.PI_BACKGROUND_TASK_JOURNAL ??= "off";
