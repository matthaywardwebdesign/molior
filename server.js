//Define variables
var APP_PORT = 2633;

//Load modules
var http = require('http');
var server = http.Server();
var io = require('socket.io')(server);
var fs = require("graceful-fs");
var path = require("path");
var ensureDir = require("ensureDir");
var crypto = require("crypto");
var walk = require("walk");
var ip = require("ip");
var exec = require("child_process").exec;

//Create projects directory
fs.mkdir('projects/', function (err){});

//Handle socket connection and events
io.on('connection', function(socket){
    console.log("Client Connected");
    socket.on('fileSync', function(data){
        //File sync requested
        fileSync(data);
    });
    socket.on('fileDelete', function (data){
        deleteFile(data);   
    });
    socket.on('fileList', function (data){
        checkFiles(data); 
    });
    socket.on('build', function (data){
       buildProject(data, function (result){
            socket.emit('buildresult', {'result': result});   
       },socket); 
    });
    socket.on('disconnect', function(){});
});

//Listen for requests
server.listen(APP_PORT);

console.log("App listening on " + ip.address() + ":" + APP_PORT);

function fileSync(data){
    //Check if the file exists
    var filePath = "projects/" + data.project + "/" + data.path;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    fs.exists(filePath, function (exists){
       if (exists){
            //File exists md5 contents and compare to what was sent
            hashFile(filePath, function (hash){
                //Compare hashes
                if (hash == data.hash){
                    //Hash matches, no need to request file
                } else {
                    //Hash doesn't match, download file from client
                    console.log("Downloading: " + data.path + " from " + data.server);
                    downloadFile("http://" + data.server + ":8888/" + data.path, data.project, data.path);
                }
            });
       } else {
            //File doesn't exist, download file from client
            console.log("Downloading: " + data.path + " from " + data.server);
            downloadFile("http://" + data.server + ":8888/" + data.path, data.project, data.path);
       }
    });
}

function hashFile(filename, callback){
    filename = filename.split("\\").join("/");
    var fd = fs.createReadStream(filename);
    var hash = crypto.createHash('md5');
    hash.setEncoding('hex');
    
    fd.on('end', function (){
        hash.end();
        callback(hash.read());
    });
    
    fd.pipe(hash);
}

var execCount = 0;

//Downloads a file from the client at the specified url
function downloadFile(url, project, filename, callback){
    var filePath = "projects/" + project + "/" + filename;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    ensureDir(path.dirname(filePath), 0777, function (){
        var file = fs.createWriteStream(filePath);
        file.on('open', function (fd){
            var request = http.get(url, function(response) {
                if (response.statusCode == 200){
                    response.pipe(file);
                    console.log("File: " + filename + " synced");
                } else {
                    console.log("Error retrieving file: " + filename); 
                }
            });
        });
    });
    
  
}

//Delete a file 
function deleteFile(data){
    var filePath = "projects/" + data.project + "/" + data.path;
    //Fix windows path issue
    filePath = filePath.split("\\").join("/");
    fs.unlink(filePath, function (err){
        if (!err){
            console.log("File: " + data.path + " deleted");   
        } else {
            console.log(err);   
        }
    });
}

//Checks for any files which have been deleted when the client software wasn't running / offline
function checkFiles(data){
    var clientList = data.files;
    //Walk the project directory on the server
    var walk    = require('walk');

    // Walker options
    var walker  = walk.walk('projects/' + data.project + "/", { followLinks: false });

    walker.on('file', function(root, stat, next) {
        //Check whether file on client list
        var filePath = path.relative( process.cwd() + "/projects/" + data.project, root + "/" +stat.name);
        if (clientList.indexOf(filePath) < 0){
            //File non existant on client, delete from project
            fs.unlink("projects/" + data.project + "/" + filePath, function (err){
                if (err){   
                    console.log(err);
                }
            });
        }
        next();
    });

    walker.on('end', function() {
        console.log("Remote sync complete");
    });
}

function buildProject(data, callback, socket){
    var done = false;
    console.log("Building.....");
    var path = "projects/" + data.project + "/" + data.builddir; 
    //Fix windows path issue
    path = path.split("\\").join("/");
    exec("cd " + path + ";xcodebuild > " + process.cwd() + "/projects/" + data.project + ".buildlog 2>&1", function (error, stdout, stderr){
        //Build complete - find result from log file
        fs.readFile(process.cwd() + "/projects/" + data.project + ".buildlog", function (err, filedata) {
            if (filedata.toString().indexOf("** BUILD SUCCEEDED **") > -1){
                //Build passed
                console.log("Build Passed");
                if (done == false){
                callback("Build Passed");
                    done = true;
                }
            } else {
                //Build failed
                if (done == false){
                console.log("Build Failed");
                callback("Build Failed");
                 done = true;   
                }
            }
            
            
            
            //Read each file line by line and find warning, notes and errors
            var lines = filedata.toString().split("\n");
            console.log("Total lines in build log: " + lines.length);
            for (var i = 0; i < lines.length; i++){
                var line = lines[i];
                
                //Check for compile line (clear warnings and errors for that file)
                if (line.indexOf("CompileC") == 0){
                       socket.emit("filecompile", {'file':line.split(" ")[2]});
                }
                //Find warnings
                if (line.indexOf("warning:") > -1){
                    var warningType = "";
                    var warningData = {};
                    if (line.split("warning:")[0] == "ld: "){
                        warningType = "linker";   
                    }
                    if (line.indexOf("warning:") == 0){
                        warningType = "plain";   
                    }
                    if (warningType == ""){
                        warningType = "code";   
                    }
                    
                    if (warningType == "linker"){
                        warningData['type'] = "linker";
                        warningData['info'] = line.split("warning: ")[1];
                        //Due to the way the xcodebuild cache works, linker warnings cannot be supported at this stage
                    }
                    
                    if (warningType == "plain"){
                        warningData['type'] = "linker";
                        warningData['info'] = line.split("warning: ")[1];
                        //Due to the way the xcodebuild cache works, plain non code warning cannot be supported at this stage
                    }
                    
                    if (warningType == "code"){
                        warningData['type'] = "code";
                        warningData['info'] = line.split("warning: ")[1].split("[").join(" ").split(":").join("-").split("]").join("").split("\'").join("");
                        var warningFile = line.split("warning: ")[0].split(":")[0].split(data.project)[1];
                        var warningInfo = line.split("warning: ")[1].split("[").join("*");
                        var warningLine = line.split("warning: ")[0].split(":");
                        warningLine = warningLine[warningLine.length - 3];
                        warningData['line'] = warningLine;
                        socket.emit("filewarning", {"file": warningFile, "warning": warningData});
                    }
                    
                }
                
                 //Find notes
                if (line.indexOf("note:") > -1){
                    var noteType = "";
                    var noteData = {};
                    if (line.split("note:")[0] == "ld: "){
                        noteType = "linker";   
                    }
                    if (line.indexOf("note:") == 0){
                        noteType = "plain";   
                    }
                    if (noteType == ""){
                        noteType = "code";   
                    }
                    
                    if (noteType == "linker"){
                        noteData['type'] = "linker";
                        noteData['info'] = line.split("note: ")[1];
                        //Due to the way the xcodebuild cache works, linker notes cannot be supported at this stage
                    }
                    
                    if (noteType == "plain"){
                        noteData['type'] = "linker";
                        noteData['info'] = line.split("note: ")[1];
                        //Due to the way the xcodebuild cache works, plain non code notes cannot be supported at this stage
                    }
                    
                    if (noteType == "code"){
                        noteData['type'] = "code";
                        noteData['info'] = line.split("note: ")[1].split("[").join(" ").split(":").join("-").split("]").join("").split("\'").join("");
                        var noteFile = line.split("note: ")[0].split(":")[0].split(data.project)[1];
                        var noteInfo = line.split("note: ")[1].split("[").join("*");
                        var noteLine = line.split("note: ")[0].split(":");
                        noteLine = noteLine[noteLine.length - 3];
                        noteData['line'] = noteLine;
                        socket.emit("filenote", {"file": noteFile, "note": noteData});
                    }
                    
                }
                
                 //Find errors
                if (line.indexOf("error:") > -1){
                    var errorType = "";
                    var errorData = {};
                    if (line.split("error:")[0] == "ld: "){
                        errorType = "linker";   
                    }
                    if (line.indexOf("error:") == 0){
                        errorType = "plain";   
                    }
                    if (errorType == ""){
                        errorType = "code";   
                    }
                    
                    if (errorType == "linker"){
                        errorData['type'] = "linker";
                        errorData['info'] = line.split("error: ")[1];
                        //Due to the way the xcodebuild cache works, linker errors cannot be supported at this stage
                    }
                    
                    if (errorType == "plain"){
                        errorData['type'] = "linker";
                        errorData['info'] = line.split("error: ")[1];
                        //Due to the way the xcodebuild cache works, plain non code errors cannot be supported at this stage
                    }
                    
                    if (errorType == "code"){
                        errorData['type'] = "code";
                        errorData['info'] = line.split("error: ")[1].split("[").join(" ").split(":").join("-").split("]").join("").split("\'").join("");
                        var errorFile = line.split("error: ")[0].split(":")[0].split(data.project)[1];
                        var errorInfo = line.split("error: ")[1].split("[").join("*");
                        var errorLine = line.split("error: ")[0].split(":");
                        errorLine = errorLine[errorLine.length - 3];
                        errorData['line'] = errorLine;
                        socket.emit("fileerror", {"file": errorFile, "error": errorData});
                    }
                    
                }
            }
        
        });
        
    });
};