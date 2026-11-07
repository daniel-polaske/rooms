@eval @eval-directory-sharding
Feature: The directory is sharded and the Router merges the shards

  Scenario: rooms land across shards and the list is complete
    Given 12 fresh rooms with one message each
    And within 30 seconds the directory lists all of my rooms
    When I send a GET request to "/api/directory"
    Then the last response status is 200
    And the response JSON field "shards" is 4
    And the response JSON array "per_shard" has 4 items
    And the response JSON field "rooms" is at least 12
    And the per-shard room counts sum to the total and at least 2 shards are non-empty

  Scenario: archiving marks the room in its shard
    Given a fresh room
    When I post 2 messages
    And I start an archive with the token
    Then within 60 seconds the archive status is "complete"
    And within 30 seconds the directory lists the room as archived
