Feature: An idle room is archived to R2 with a verified copy
  Stage 3: alarm -> Workflow -> R2. Run locally with the .dev.vars example
  (ARCHIVE_GRACE=5 seconds) so the durable sleep is short.

  Scenario: the directory learns about posts through the queue, not from rooms
    Given a fresh room
    When I post 3 messages
    Then within 30 seconds the directory lists the room with 3 messages

  Scenario: a manual archive runs export, grace, verify and mark
    Given a fresh room
    When I post 3 messages
    And I start an archive with the token
    Then the last response status is 202
    And within 60 seconds the archive status is "complete"
    And the archive body lists 3 messages
    And within 30 seconds the directory lists the room as archived

  Scenario: the archive endpoint needs the shared secret
    Given a fresh room
    When I start an archive without the token
    Then the last response status is 403
