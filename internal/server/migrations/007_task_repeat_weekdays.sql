-- 每周任务从「一个星期几」变成「可以选几个星期几」。
-- repeat_weekdays 是升序去重的 "0".."6" 逗号串（"1,3,5"）；空串表示「只有
-- repeat_weekday 那一天」，也就是老数据的形状 —— 所以既不用回填，单天任务
-- 的实例 period_key 也不会因为这次改动而换格式。
-- 实例表带上同一列是快照：前端列任务时不用回头查模板。
ALTER TABLE task_templates ADD COLUMN repeat_weekdays TEXT NOT NULL DEFAULT '';
ALTER TABLE task_instances ADD COLUMN repeat_weekdays TEXT NOT NULL DEFAULT '';
