-- Acceptance never moves (SPEC §12.5): a Recommendation page shows the most
-- recent ACCEPTED version if one exists, otherwise the latest. Two accepted
-- siblings would make "the accepted one" ambiguous and leave the page's answer
-- depending on row order, so at most one version of a Recommendation may carry
-- `accepted` at a time. The action that marks clears the sibling in the same
-- transaction; this index is what makes the state unrepresentable if it ever
-- forgets. It is partial, because `rejected` and `needs_work` are ordinary
-- marks a person may leave on as many versions as they read.
CREATE UNIQUE INDEX "recommendation_version_one_accepted_key" ON "recommendation_version" USING btree ("recommendation_id") WHERE "recommendation_version"."human_mark" = 'accepted';
