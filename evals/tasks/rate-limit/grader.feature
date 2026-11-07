@eval @eval-rate-limit
Feature: An author is limited to 60 posts a minute

  Background:
    Given a fresh room

  Scenario: the 61st post in a minute is refused with a retry hint, other authors are not
    When I post 60 messages as "spammer"
    And I post a message as "spammer" with body "one too many"
    Then the last response status is 429
    And the response header "retry-after" is present
    And the response JSON field "error" is "rate limited"
    And the response JSON field "retry_after" is present
    When I post a message as "calm" with body "still fine"
    Then the last response status is 201
    And the room history has exactly 61 messages

  Scenario: the limit applies over the socket too
    When I post 60 messages as "spammer"
    And I open a websocket to the room as "spammer"
    And the websocket for "spammer" posts a message with msg_id "ws-61" and body "over"
    Then within 5 seconds the websocket for "spammer" receives an event of type "error"
    And that event's field "msg_id" is "ws-61"
    And that event's field "reason" is "rate limited"
    And the room history has exactly 60 messages
