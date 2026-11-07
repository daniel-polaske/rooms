Feature: A room keeps its promises under failure
  The invariants from src/room.ts, exercised over HTTP against a running Worker.
  These are the acceptance criteria. Code that changes what they say does not merge.

  Background:
    Given a fresh room

  Scenario: I3 - a replayed post is not a second message
    When I post a message with msg_id "m-1" and body "hello"
    And I post a message with msg_id "m-1" and body "hello again"
    Then the last response status is 200
    And the last response is marked duplicate
    And the room history has exactly 1 message
    And the only message has body "hello"

  Scenario: I1 - history is in total order
    When I post 20 messages
    Then the history seqs are strictly increasing
    And the room reports 20 messages

  Scenario: I2 - no acknowledged write is lost when the object is killed mid-stream
    When I post 300 messages while killing the room every 25 posts
    Then every acknowledged msg_id appears in history exactly once
    And the history seqs are strictly increasing
    And the object was reset at least once

  Scenario: a reset keeps SQLite and changes the incarnation
    When I post a message with msg_id "keep" and body "durable"
    And I kill the room
    Then the room has a new incarnation
    And the room history has exactly 1 message

  Scenario: fault injection needs the shared secret
    When I request chaos "throw" without the token
    Then the last response status is 403
    When I request chaos "bogus" with the token
    Then the last response status is 400
    When I request chaos "throw" with the token
    Then the last response status is 500
    And the last response carries a trace id

  Scenario: a bad room name never reaches an object
    When I GET "/api/rooms/Not%20A%20Room"
    Then the last response status is 400
