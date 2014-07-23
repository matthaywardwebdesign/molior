//Retrieve command line arguments and store in variables
var config = require("./" + process.argv[2]);
var WORKING_DIRECTORY = config.working_directory;
var SERVER = config.server;
var BUILD_DIRECTORY = config.build_directory || "/";
var BUILD_SCHEME = config.build_scheme;
var BUNDLE_ID = config.bundle_id;
var APP_NAME = config.appname;
console.log("Build directory: " + BUILD_DIRECTORY);
//Include modules
var io = require('socket.io-client');
var btoa = require('btoa');
var fs = require('fs');
var walk = require('walk');
var crypto = require('crypto');
var path = require('path');
var http = require('http');
var url = require('url');
var ip = require('ip');
var btoa = require('btoa');
var watch = require('watch');
var PROJECT = btoa(WORKING_DIRECTORY);

//Define build status variables
var buildStatus = {};
buildStatus['state'] = "idle";
buildStatus['last_build_result'] = "";
buildStatus['last_build_time'] = 0;
buildStatus['files_compiled'] = [];
buildStatus['build_warnings'] = {};
buildStatus['build_notes'] = {};
buildStatus['build_errors'] = {};

//Load the deploy template
var DEPLOY_TEMPLATE = fs.readFileSync("deploy.html");

//Change the working directory to the specified directory
process.chdir(WORKING_DIRECTORY);

//Connect to server
var socket = io.connect('http://' + SERVER + ":2633", {
    'reconnection delay': 100,
    'reconnection limit': 100,
    'max reconnection attempts': Infinity
});
buildStatus['state'] = "waiting for connection";
socket.on('connect', function () {
    connected();
    socket.on('buildresult', function (data) {
        console.log(data.result);
        buildStatus['state'] = "idle";
        buildStatus['last_build_result'] = data.result;
    });
    socket.on('filecompile', function (data) {
        buildStatus['files_compiled'].push(data.file);
        buildStatus['build_warnings']["/" + path.normalize(BUILD_DIRECTORY + "/").split("\\").join("/") + data.file] = [];
        buildStatus['build_notes']["/" + path.normalize(BUILD_DIRECTORY + "/").split("\\").join("/") + data.file] = [];
        buildStatus['build_errors']["/" + path.normalize(BUILD_DIRECTORY + "/").split("\\").join("/") + data.file] = [];
    });
    socket.on('filewarning', function (data) {
        if (buildStatus['build_warnings'][data.file] == 'undefined' || buildStatus['build_warnings'][data.file] == null) {
            buildStatus['build_warnings'][data.file] = [];
            buildStatus['build_warnings'][data.file].push(data.warning);
        } else {
            buildStatus['build_warnings'][data.file].push(data.warning);
        }
    });
    socket.on('filenote', function (data) {
        if (buildStatus['build_notes'][data.file] == 'undefined' || buildStatus['build_notes'][data.file] == null) {
            buildStatus['build_notes'][data.file] = [];
            buildStatus['build_notes'][data.file].push(data.note);
        } else {
            buildStatus['build_notes'][data.file].push(data.note);
        }
    });
    socket.on('fileerror', function (data) {
        if (buildStatus['build_errors'][data.file] == 'undefined' || buildStatus['build_errors'][data.file] == null) {
            buildStatus['build_errors'][data.file] = [];
            buildStatus['build_errors'][data.file].push(data.error);
        } else {
            buildStatus['build_errors'][data.file].push(data.error);
        }
    });
    socket.on('deploydone', function(data){
        console.log("Deploy done"); 
        buildStatus['state'] = "idle";
    });
    socket.on('disconnect', function () {
        buildStatus['state'] = "waiting for connection";
    });
});

//Called once connected
function connected() {
    //Sync the working directory with the server
    sync();
}


function sync() {
    buildStatus['state'] = "syncing";
    console.log("Syncing with remote");
    console.log("- Walking directory");

    // Walker options
    var walker = walk.walk('./', {
        followLinks: false
    });
    var files = [];
    // Loop through each file in the directory
    walker.on('file', function (root, stat, next) {
        //MD5 the files contents
        hashFile(root + "/" + stat.name, function (hash) {
            //Get the filepath relative to the working directory
            var filePath = path.relative(WORKING_DIRECTORY, root + "/" + stat.name);
            //Send file information to server along with project name
            socket.emit('fileSync', {
                'path': filePath,
                'hash': hash,
                'project': PROJECT,
                'server': ip.address()
            });
        });
        files.push(path.relative(WORKING_DIRECTORY, root + "/" + stat.name).split("\\").join("/"));
        next();
    });

    walker.on('end', function () {
        buildStatus['state'] = "idle";
        console.log("Walking directory done");
        //Send file list to server
        socket.emit('fileList', {
            'files': files,
            'project': PROJECT
        });
        if (watching == false) {
            startWatch();
        }
    });
}

//MD5 hash a file
function hashFile(filename, callback) {
    var fd = fs.createReadStream(filename);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');

    fd.on('end', function () {
        hash.end();
        callback(hash.read());
    });

    fd.pipe(hash);
}

//Create HTTP file server
http.createServer(function (request, response) {
    var uri = url.parse(request.url).pathname,
        filename = decodeURI(path.join(process.cwd(), uri));
    fs.exists(filename, function (exists) {
        if (!exists) {
            response.writeHead(404, {
                "Content-Type": "text/plain"
            });
            response.write("404 Not Found\n");
            response.end();
            return;
        }

        fs.readFile(filename, "binary", function (err, file) {
            if (err) {
                response.writeHead(500, {
                    "Content-Type": "text/plain"
                });
                response.write(err + "\n");
                response.end();
                return;
            }

            response.writeHead(200);
            response.write(file, "binary");
            response.end();
        });
    });
}).listen(8888);

console.log("File server listening on " + ip.address());

var watching = false;
//Create directory watcher
function startWatch() {
    watching = true;
    console.log("Started watching directory");
    watch.createMonitor(WORKING_DIRECTORY, function (monitor) {
        monitor.on("created", function (f, stat) {
            // Check whether file or directory
            fs.stat(f, function (err, stat) {
                if (stat.isFile()) {
                    syncFile(f);
                }
            });

            console.log("Create: " + path.relative(WORKING_DIRECTORY, f));
        });
        monitor.on("changed", function (f, curr, prev) {
            // Check whether file or directory
            fs.stat(f, function (err, stat) {
                if (stat.isFile()) {
                    syncFile(f);
                }
            });

            console.log("Changed: " + path.relative(WORKING_DIRECTORY, f));
        });
        monitor.on("removed", function (f, stat) {
            // Handle removed files
            console.log("Remove: " + path.relative(WORKING_DIRECTORY, f));
            // Tell server to delete file
            deleteFile(f);
        });
    });
}


//Syncs a single file
function syncFile(filename) {
    hashFile(filename, function (hash) {
        //Get the filepath relative to the working directory
        var filePath = path.relative(WORKING_DIRECTORY, filename);
        //Send file information to server along with project name
        socket.emit('fileSync', {
            'path': filePath,
            'hash': hash,
            'project': PROJECT,
            'server': ip.address()
        });
    });
}

//Delete a file from the remote server
function deleteFile(filename) {
    var filePath = path.relative(WORKING_DIRECTORY, filename);
    //Send file information to server along with project name
    socket.emit('fileDelete', {
        'path': filePath,
        'project': PROJECT
    });
}

//Create HTTP API server
http.createServer(function (request, response) {
    var uri = url.parse(request.url).pathname,
        filename = decodeURI(uri);
    if (filename == "/build") {
        //Tell server to do a build
        socket.emit('build', {
            'project': PROJECT,
            'builddir': BUILD_DIRECTORY,
            'scheme': BUILD_SCHEME
        });
        console.log("Building.....");
        buildStatus['state'] = 'building';
        buildStatus['files_compiled'] = [];
        buildStatus['last_build_time'] = (new Date).getTime();
    }
    
    if (filename == "/deploy") {
        //Tell the server to build and deploy
        socket.emit('deploy', {
            'project': PROJECT,
            'builddir': BUILD_DIRECTORY,
            'scheme': BUILD_SCHEME,
            'bundleid': BUNDLE_ID,
            'appname': APP_NAME
        });
        console.log("Deploying.....");
        buildStatus['state'] = 'deploying';
        buildStatus['files_compiled'] = [];
        buildStatus['last_build_time'] = (new Date).getTime();
        
    }
    
    if (filename == "/status") {
        response.write(JSON.stringify(buildStatus));
    }
    
    if (filename == "/ipad"){
            var deployTemplate = DEPLOY_TEMPLATE.toString();
            deployTemplate = deployTemplate.split("$SERVER$").join(SERVER);
            deployTemplate = deployTemplate.split("$PROJECT$").join(PROJECT.split("=").join("-"));
            response.write(deployTemplate);
    }
    
      if (filename == "/status/basic") {
        response.write(JSON.stringify({state: buildStatus['state'],last_build_result: buildStatus['last_build_result'], last_build_time: buildStatus['last_build_time'], project_path: path.normalize(WORKING_DIRECTORY + "/").split("\\").join("/")}));
    }
    response.end();
}).listen(8080);