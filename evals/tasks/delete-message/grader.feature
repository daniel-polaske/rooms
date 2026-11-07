@eval @eval-delete-message
Feature: A message can be soft-deleted without breaking total order

  Background:
    Given a fresh room
    When I post a message with msg_id "keep" and body "stays"
    And I post a message with msg_id "gone" and body "goes"

  Scenario: deletion needs the shared secret
    When I send a DELETE request to "/api/rooms/{room}/messages/{last_seq}"
    Then the last response status is 403
    And the room history has exactly 2 messages

  Scenario: a deleted message keeps its seq, loses its body, and the room is told
    When I open a websocket to the room as "watcher"
    And I send a DELETE request to "/api/rooms/{room}/messages/{last_seq}" with the token
    Then the last response status is 200
    And the response JSON field "deleted" is the boolean true
    And within 5 seconds the websocket for "watcher" receives an event of type "deleted"
    And that event's field "seq" matches the last seq
    When I send a GET request to "/api/rooms/{room}/messages"
    Then the response JSON array has 2 items
    And the response JSON field "0.msg_id" is "keep"
    And the response JSON field "0.deleted" is the boolean false
    And the response JSON field "1.msg_id" is "gone"
    And the response JSON field "1.body" is ""
    And the response JSON field "1.deleted" is the boolean true

  Scenario: deleting twice is idempotent and an unknown seq is a 404
    When I send a DELETE request to "/api/rooms/{room}/messages/{last_seq}" with the token
    And I send a DELETE request to "/api/rooms/{room}/messages/{last_seq}" with the token
    Then the last response status is 200
    When I send a DELETE request to "/api/rooms/{room}/messages/999999" with the token
    Then the last response status is 404
