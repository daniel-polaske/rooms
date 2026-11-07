@eval @eval-author-stats
Feature: A room can report who has posted

  Background:
    Given a fresh room

  Scenario: an empty room has no authors
    When I send a GET request to "/api/rooms/{room}/authors"
    Then the last response status is 200
    And the response JSON array has 0 items

  Scenario: authors are counted and ordered by activity, then name
    When I post 2 messages as "bob"
    And I post 2 messages as "ann"
    And I post 1 messages as "cid"
    And I send a GET request to "/api/rooms/{room}/authors"
    Then the last response status is 200
    And the response JSON array has 3 items
    And the response JSON field "0.author" is "ann"
    And the response JSON field "0.messages" is 2
    And the response JSON field "1.author" is "bob"
    And the response JSON field "1.messages" is 2
    And the response JSON field "2.author" is "cid"
    And the response JSON field "2.messages" is 1
    And the response JSON field "2.last_seq" is 5

  Scenario: a duplicate post does not count twice
    When I post a message with msg_id "dup" and body "once"
    And I post a message with msg_id "dup" and body "once"
    And I send a GET request to "/api/rooms/{room}/authors"
    Then the response JSON array has 1 item
    And the response JSON field "0.messages" is 1
