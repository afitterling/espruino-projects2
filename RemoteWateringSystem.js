//////////////////////////////////////////////////////////////////
// Modules
var at = require('http://localhost:3000/AT.js').connect(Serial2);
var gprsmod = require('http://localhost:3000/SIM900.js');
var Clock = require('http://localhost:3000/clock.js').Clock;
var WaterCycle = require('http://localhost:3000/watering.js').Cycle;
var FlowMeter = require('http://localhost:3000/flowmeter.js');
var $http = require('http://localhost:3000/carriots.js').http;
var clk = new Clock();
var settings = require('http://localhost:3000/settings.js')

$http.defaultHeaders['carriots.apiKey'] = settings.carriot.apiKey;

WaterCycle(1,0);
WaterCycle(2,0);

// PINs

/*

B4:  Trigger SIM900 1. on 2. off 3. on .........
A4:  signal flow meter

Flowmeter:
brown plus
schwarz minus
orange signal
(aufgelötete Kabel)


aussen anschlüsse:

grau pumpe
schwarz cycle1
brown cycle2

*/

// TIMESPANS

var MAIN_INTERVAL_LENGTH = 4; // min
var RESET_INTERVAL_LENGTH = MAIN_INTERVAL_LENGTH * 8 + 5;

// IPAddress
var IPAddress = "10.228.192.245";
var online = false; // obsolete?
var modem = false; // obsolete?
var reconnectRunning = false;
var mainLoop, mainLoopInterval, getJobsTimeout, getJobsTimeoutFlag;
var reconnectInterval;
var feedbackInterval;
var work;
var gprs;
var nReset = 0;
var reconnectNum=0;
var nError=0, nReq=0;
var SECONDSINMINUTES = 60;


function uplink(callback, callback2){
  reconnectRunning = true;
  console.log("Connecting to SIM900 module " + clk.getDate().toString());
  gprs = require('http://localhost:3000/SIM900.js').connect(Serial2, null /*reset*/, function(err) {
    if(!err) {
      // success
      gprs.connect(settings.carrier.host, settings.carrier.user, settings.carrier.password, function(err) {
        //
        gprs.getIP(function(err, ip) {
          console.log('IP:' + ip, 'error:', err);

          // success

          online = true;
          reconnectRunning = false;

          if (ip===undefined || err){
            if (callback2){
              return callback2();
            }
            return;
          }

          if (callback){
            return callback();
          }

        });
      });
    } else {
      //error
      reconnectRunning = false;
      console.log('connect error');
      online=false;
      if (callback2){
        return callback2();
      }
    }
  });
}


function isOnline(fn, fn2) {
  at.cmd("AT+CIFSR\r\n",1000, function(d){
    if (d==="ERROR" || d!==IPAddress){
      online=false;
      setTimeout(function(){
        if (fn2){
          fn2();
        }
      },1000);
    } else {
      online=true;
      setTimeout(function(){
        if (fn){
          return fn();
        }
      },1000);
    }
  });
}

function isOnlinePromised() {
  var p = new Promise(function(resolve, reject){
    at.cmd("AT+CIFSR\r\n",1000, function(d){
      if (d==="ERROR" || d!==IPAddress){
        resolve();
      } else {
        reject();      }
    });
  });
  return p;
}


/* this function 
   powers the SIM900 on/off by triggering the button "power"
*/
function toggleSIM900(fn){
  digitalWrite(B4, 0);
  setTimeout(function(){
    digitalWrite(B4, 1);
    if (fn){
      return fn();
    }
  }, 500);
}

/*
  this cuts the SIM900 power supply 
  and reestablishs it
 */
function resetSIM(fn){
  console.log("reset invoked");
  reconnectNum=reconnectNum+1;
  digitalWrite(A5,1);
  setTimeout(function(){
    nReset=nReset+1;
    console.log('reset end');
    digitalRead(A5);
    if (gprs && gprs.init){
//      gprs.init(function(){});
    }
    toggleSIM900(fn);
  }, 5000);
}

function requestsNew(){
  return isOnline(function(){
  return $http({
      host: 'api.carriots.com',
      path: '/streams/',
      port: '80',
      method: 'GET',
      params: {
        _t: 'str',
        device: 'Commander@afitterling.afitterling',
        max: 1
      }
    }).then(function(req1){
          // success
          var totalDocs;
          var results;
          if (req1 && req1.total_documents){
            totalDocs=req1.total_documents;
          }
          if (req1 && req1.result){
            results=req1.result;
          }
          $http({
            host: 'api.carriots.com',
            path: '/status/',
            port: '80',
            protocol: "v1",
            checksum: "",
            device: "defaultDevice@afitterling.afitterling",
            at: "now",
            method:'POST',
            data: {
              stats: {
                errors: nError,
                requests: nReq,
                resets: nReset,
                total_docs: totalDocs,
                result_length: results,
                errorFlags: E.getErrorFlags(),
                process: process.memory()
              }
            }
          }).then(function(data){
            // success
              nReq=nReq+1;
            
            // JOB HANDLING
            if (req1 && req1.result){
                processJobs(req1.result);
            }
            jobRunner();
            
          }, function(){
            //error
          nError=nError+1;
          nReq=nReq+1;
      });
    }, function(){
      // error
      nError=nError+1;
      nReq=nReq+1;
    });
  }, function(){
    console.log('error while trying a request - calling reconnect');
    reconnectLoopFunc();
  });
}

function setupMainLoop(fn){
  if (mainLoopInterval) return;
  console.log('init of main loop called');
  mainLoop = setInterval(requestsNew, MAIN_INTERVAL_LENGTH * 60 * 1000);
  mainLoopInterval = true;
  return requestsNew();
}

function clearMainLoop(){
  if (mainLoopInterval){
    console.log('clearing mainLoop');
    mainLoopInterval = null;
    clearInterval(mainLoop);
  }
}

function reconnectLoopFunc(){
  console.log('reconnectLoop called, clearing mainLoop');
  clearMainLoop();
  return resetSIM(function(){
    // success
    console.log('timeout for uplink');
    setTimeout(function(){
      return uplink(function(){
        // success
        setupMainLoop();
      }, function(){
        // error
      });
    }, 20000);
  });
}

function setupReconnectLoop(){
  console.log('init of reconnect loop called');
//  reconnectInterval = setInterval(reconnectLoopFunc, RESET_INTERVAL_LENGTH * 60 * 1000);
  setTimeout(reconnectLoopFunc);
}

/////////////////jobs

var JobsQ;
var workQ=[];

function isInWorkQAlready(jobid){
  return workQ.some(function(item){
    console.log(item.id);
    return item.id === jobid;
  });
}

function filterAndModifyJobs(jobsData){
  return jobsData.map(function(job){
    var jobData = job.data;
    if (!isInWorkQAlready(job.id_developer)){
      jobData.status=null;
      jobData.id=job.id_developer;
      return jobData;
    }
  });
}

var activeJob=null;
var jobIterations=0;

function validJob(job){
  // in case of a valid job
  if (job && job.cycle && job.time){
    return job;
  }
  // in case of any uploaded data as job data, but has not passed valid above
  if (job && job.id){
      $http({
        host: 'api.carriots.com',
        path: '/streams/' + job.id + '/',
        port: '80',
        method: 'DELETE'
      }).then(function(){
          $http({
            host: 'api.carriots.com',
            path: '/streams/',
            port: '80',
            protocol: "v1",
            checksum: "",
            device: "defaultDevice@afitterling.afitterling",
            at: "now",
            method:'POST',
              data: {
                job:"invalid",
                data: job
              }
          });
      });
  }
  // in case of anything but the above
  workQ.shift(); // erase invalid job
  return null;
}

function jobRunner(){
  if (!activeJob && validJob(workQ[0])){
    activeJob = workQ[0];
    jobIterations = 0;
    // run the job on the HW
    console.log('job started', activeJob);

    clearMainLoop();
    return applyJobToHWAsChunks(activeJob.cycle, activeJob.time, function(){
        setupMainLoop();
    });
  }
}

function applyJobToHWAsChunks(cycle, lengthInMin ,fn){

  // flow meter on
  
  // clear main Loop
//  clearMainLoop();

  console.log('water cycle', activeJob.cycle, 1);

  // status

  WaterCycle(activeJob.cycle, 1);

  /*
  setTimeout(function(){
    flowMeterData.push(readFlowMeter());
  }, 15*1000);
*/
  return setTimeout(function(){
    /* if max length */
    jobIterations = jobIterations + 1;
    if (jobIterations >= lengthInMin) {
      WaterCycle(activeJob.cycle, 0);
      activeJob.status = 'finished';
      console.log('job finished');

      // suspend this later or at least make sure you are online
      $http({
        host: 'api.carriots.com',
        path: '/streams/' + activeJob.id + '/',
        port: '80',
        method: 'DELETE',
      }).then(function(){
        workQ.splice(workQ.indexOf(activeJob),1);
        // already removed?
        $http({
            host: 'api.carriots.com',
            path: '/streams/',
            port: '80',
            protocol: "v1",
            checksum: "",
            device: "defaultDevice@afitterling.afitterling",
            at: "now",
            method:'POST',
            data: {
              job: "done",
              data: activeJob
            }
        });
      }).then(function(){
        activeJob = null;

        return setTimeout(function(){
          if (fn){
            return fn();
          }
        }, 30*1000);

      });

      return;
    }

    return applyJobToHWAsChunks(cycle, lengthInMin, fn);
  }, 1 * SECONDSINMINUTES * 1000);

}


function processJobs(jobsData){
  if (!jobsData) return;
  console.log('processJobs', jobsData);

  filterAndModifyJobs(jobsData).forEach(function(item){
    workQ.push(item);
  });

}


////////////////////////
// Initialization
////////////////////////

var lock;

E.on('init', function(){

//  console.log('initialization ..... ');

  // FlowMeter initialization
  FlowMeter.setup(A4);
  FlowMeter.run();

  setTimeout(function(){
    var val = FlowMeter.calibrate();
    if (val<0.5){
      digitalPulse(LED2,1, [600,260,600]);
    } else {
      digitalPulse(LED1,1, [600,260,600]);
    }
  }, 10000);

//  Serial2.setup(115200);
  Serial2.setup(9600);
//  Serial2.on('data', function(data){ console.log(data);});

  setupReconnectLoop();

//  console.log('initialization done ' + clk.getDate().toString());
  digitalPulse(LED1,1, [50,260,50]);

});


//isOnline(function(){ console.log('s'); }, function(){ console.log('e');})