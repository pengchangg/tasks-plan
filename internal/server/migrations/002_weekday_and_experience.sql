ALTER TABLE task_templates ADD COLUMN repeat_weekday INTEGER NOT NULL DEFAULT 1 CHECK (
    repeat_weekday BETWEEN 0 AND 6
);
ALTER TABLE task_instances ADD COLUMN repeat_weekday INTEGER NOT NULL DEFAULT 1 CHECK (
    repeat_weekday BETWEEN 0 AND 6
);

-- Earlier builds stored only the current level progress in experience.
UPDATE children
SET experience = ((level - 1) * 100) + experience;
