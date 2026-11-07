@eval @eval-message-size
Feature: Messages have a size limit

  Background:
    Given a fresh room

  Scenario: a body of exactly 4096 bytes is accepted
    When I post a message with a body of 4096 bytes
    Then the last response status is 201
    And the room history has exactly 1 message

  Scenario: a body of 4097 bytes is rejected and stored nowhere
    When I post a message with a body of 4097 bytes
    Then the last response status is 413
    And the response JSON field "error" is "body too large"
    And the response JSON field "max" is 4096
    And the room history has exactly 0 messages

  Scenario: the same limit applies over the socket
    When I open a websocket to the room as "big"
    And the websocket for "big" posts a message with a body of 4097 bytes and msg_id "too-big"
    Then within 5 seconds the websocket for "big" receives an event of type "error"
    And that event's field "msg_id" is "too-big"
    And that event's field "reason" is "body too large"
    And the room history has exactly 0 messages
