// Description:
// Prototype stackstorm hubot integration
//
// Commands:
//   hubot run <command> [<argument>, ...] - calls out to run the shell staction.
'use strict';

var _ = require('lodash')
  , rsvp = require('rsvp')
  , parse = require('../lib/parser.js')
  ;

var formatCommand = function(command) {
  var template = 'hubot run ${name} ${params} - ${description}';

  return _.template(template, {
    name: command.name,
    description: command.description,
    params: _.map(command.parameters, function (v, k) {
      if (v.immutable) {
        return ''
      }
      if (v.default) {
        return '[' + k + '=' + v.default + ']';
      }
      return '[' + k + ']';
    }).join(' ')
  });
};

module.exports = function(robot) {

  // Handle uncaught exceptions
  robot.error(function(err) {
    return robot.logger.error('Uncaught exception:', err);
  });


  // Promise helper for HTTP requests.
  var promiseMe = function (target) {
    return new rsvp.Promise(function (ok, fail) {
      target(function (err, res, body) {

        if (err) {
          fail(err);
        }

        if (res.statusCode >= 400) {
          fail(res.req.method + ' ' + res.req.path +
            ' resulted in error status code ' + res.statusCode);
        }

        try {
          body = JSON.parse(body);
        } catch (err) {
          fail(err);
        }

        ok({
          res: res,
          body: body
        });

      });
    });
  };


  var client = robot.http(process.env.HUBOT_STANLEY_URL || 'http://localhost:9101');


  // Figure out format. Since we're not going to change adapter at runtime, we can pick proper
  // format once during initialization and use it throughout the livetime of the script.
  var baseFormat = function (execution) {
    var template_structured = [
      'STATUS: ${status}',
      '<% _.forEach(result, function(host, hostname) { %>',
      'Results for ${hostname}',
      '  STDOUT: ${host.stdout}',
      '  STDERR: ${host.stderr}',
      '  EXIT CODE: ${host.return_code}',
      '<% }); %>'
    ].join('\n');

    var template_basic = [
      'STATUS: ${status}',
      'RESULT: ${result}'
    ].join('\n');

    var template = template_basic;
    // Assume it is necessary to stringify the result.
    var stringify = true
    for(var k in execution.result) {
      if (execution.result[k].hasOwnProperty('stdout')) {
        template = template_structured;
        // JSON/structured result can be handled so no stringify for you.
        stringify = false
        break;
      }
    }
    if (stringify) {
      execution.result = JSON.stringify(execution.result)
    }

    return _.template(template, {
      status: execution.status,
      result: execution.result
    });
  };

  var hipchatFormat = function () {
    return '/code ' + baseFormat.apply(this, arguments);
  };

  var format = {
    'hipchat': hipchatFormat
  }[robot.adapterName.toLowerCase()] || baseFormat;


  // Populate help with Stanley's actions.
  rsvp.all([
    promiseMe(client.scope('/actions').get()),
    promiseMe(client.scope('/runnertypes').get())
  ]).then(function (d) {

    d = _.zipObject(['actions', 'types'], d);

    _.each(d.actions.body, function (action) {

      var runner = _.find(d.types.body, function (type) {
        return type.name === action.runner_type;
      });

      action.parameters = _({})
        .assign(runner.runner_parameters)
        .assign(action.parameters)
        .value();

      robot.commands.push(formatCommand(action));

    });

  }).catch(function (err) {
    robot.emit('error', err);
  });


  // Handle `run` command
  robot.respond(/run\s+(\S+)\s*(.*)?/i, function (msg) {

    var command = msg.match[1]
      , args = msg.match[2]
      ;

    promiseMe(client.scope('/actions').get()).then(function (data) {
      // Looks for the action requested

      var action = _.find(data.body, function (e) {
        return e.name === command;
      });

      if (!action) {
        throw new Error('Action not found: ' + command);
      }

      return action;

    }).then(function (action) {
      // Requests for the runner type for the action

      return promiseMe(client.scope('/runnertypes/').query('name', action.runner_type).get())
        .then(function (type) {
          // Extends action's parameters with the ones defined by runner

          client.query('name');

          var updated_runner_params = _.reduce(type.body[0].runner_parameters,
                                               function (result, value, key) {
            result[key] = value;
            if (!action.parameters.hasOwnProperty(key)) {
              return result
            }
            for (var prop in action.parameters[key]) {
              result[key][prop] = action.parameters[key][prop]
            }
            return result
          }, {});

          action.parameters = _({})
            .assign(action.parameters)
            .assign(updated_runner_params)
            .value();

          return action;

        });

    }).then(function (action) {
      // Prepares payload for ActionExecution

      var payload = {
        action: action.ref,
        parameters: parse(args, action.parameters)
      };

      return payload;

    }).then(function (payload) {
      // Creates ActionExecution

      return promiseMe(client.scope('/actionexecutions/').post(JSON.stringify(payload)));

    }).then(function (execution) {
      // Tries to get the results of the execution until either the action is finished or when
      // there is no more retries left.

      var RETRY = 10
        , TIMEOUT = 1000
        ;

      var retry = function (retries) {
        return new rsvp.Promise(function (ok, fail) {
          setTimeout(function () {

            promiseMe(client.scope('/actionexecutions/' + execution.body.id).get())
              .then(function (execution) {
                // Fetches the results for execution

                if (execution.body.status !== 'failed' && execution.body.status !== 'succeeded') {
                  if (retries) {
                    process.stdout.write('.');
                    return retry(--retries);
                  }
                }

                return execution.body;

              }).then(ok).catch(fail);

          }, TIMEOUT);
        });
      };

      return retry(RETRY);

    }).then(function (execution) {
      // Format results

      return msg.send(format(execution));

    }).catch(function (err) {
      robot.emit('error', err);
    });

  });


  // Listen HTTP endpoint for incoming commands
  robot.router.post('/stormbot/st2', function(req, res) {
    var data, user, message;
    user = {};
    if (process.env.HUBOT_ADAPTER_ROOM) {
      user.room = process.env.HUBOT_ADAPTER_ROOM;
    }
    if (data = req.body.payload) {
      message = "/code ";
      message = message + "[" + data.source + " " + data.name + "]\n";
      if (msg = JSON.parse(data.msg)) {
        for (var k in msg) {
          message = message + "    " + k.toUpperCase() + ":" + msg[k] + "\n";
        }
      } else {
        message = message + data.msg
      }
      robot.send(user, message);
      return res.end('{"status": "completed", "msg": "Message posted successfully"}');
    } else {
      return res.end('{"status": "failed", "msg": "An error occurred trying to post the message"}');
    }
  });

};
